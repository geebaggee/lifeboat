#!/usr/bin/env bash
# Nightly dump and optional storage copy, or a monthly restore into throwaway Postgres.
# pg_dump only reads DATABASE_URL. psql and pg_restore run only against RESTORE_DATABASE_URL.
# The dump is encrypted on the runner before upload when encryption is on, which is the default.
# Secrets are masked and are not printed.
# An empty string is treated as unset, because GitHub passes "" for a missing variable.
set -euo pipefail

mask() {
  local value="${1-}"
  [[ -n "$value" ]] || return 0
  printf '%s\n' "::add-mask::${value}"
}

mask_url_secret() {
  local url="${1-}"
  if [[ "$url" =~ ://[^/@:]+:([^@]+)@ ]]; then
    mask "${BASH_REMATCH[1]}"
  fi
}

mask "${DATABASE_URL:-}"
mask_url_secret "${DATABASE_URL:-}"
mask "${RESTORE_DATABASE_URL:-}"
mask_url_secret "${RESTORE_DATABASE_URL:-}"
mask "${S3_ACCESS_KEY_ID:-}"
mask "${S3_SECRET_ACCESS_KEY:-}"
mask "${STORAGE_S3_ACCESS_KEY_ID:-}"
mask "${STORAGE_S3_SECRET_ACCESS_KEY:-}"
mask "${LIFEBOAT_ENCRYPTION_PASSPHRASE:-}"
mask "${CHECKIN_SECRET:-}"

# The workflow records the database it actually started. The action input is only the fallback.
if [[ -n "${RUNNER_TEMP:-}" && -f "${RUNNER_TEMP}/lifeboat-restore-url" ]]; then
  RESTORE_DATABASE_URL="$(tr -d '\r\n' < "${RUNNER_TEMP}/lifeboat-restore-url")"
  mask "${RESTORE_DATABASE_URL}"
  mask_url_secret "${RESTORE_DATABASE_URL}"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${LIFEBOAT_MODE:-backup}"

value_or() {
  if [[ -z "${1:-}" ]]; then
    printf '%s' "$2"
  else
    printf '%s' "$1"
  fi
}

ENDPOINT="$(value_or "${S3_ENDPOINT:-}" "https://s3.ap-southeast-2.wasabisys.com")"
REGION="$(value_or "${S3_REGION:-}" "ap-southeast-2")"
PREFIX="$(value_or "${S3_PREFIX:-}" "lifeboat")"
ENCRYPT="$(value_or "${LIFEBOAT_ENCRYPT:-}" "true")"
MANAGE_RETENTION="$(value_or "${LIFEBOAT_MANAGE_RETENTION:-}" "true")"
BUCKET="${S3_BUCKET:-}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
WORKDIR="${LIFEBOAT_WORKDIR:-$(mktemp -d)}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-}"
export AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_S3_ADDRESSING_STYLE="${AWS_S3_ADDRESSING_STYLE:-path}"
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

DUMP_BYTES=0
STORAGE_OBJECTS=0
DELETED_OBJECTS=0
LIFEBOAT_ERROR=""
LIFEBOAT_OK=false
REPORTING=0

aws_s3() {
  aws --endpoint-url "$ENDPOINT" "$@"
}

fail() {
  LIFEBOAT_ERROR="$1"
  echo "$1" >&2
  exit 1
}

report() {
  local status=$?
  if [[ "$REPORTING" -eq 1 ]]; then
    exit "$status"
  fi
  REPORTING=1
  if [[ "$status" -eq 0 ]]; then
    LIFEBOAT_OK=true
  elif [[ -z "$LIFEBOAT_ERROR" ]]; then
    LIFEBOAT_ERROR="Lifeboat failed with status ${status}"
  fi
  LIFEBOAT_OK="$LIFEBOAT_OK" \
    LIFEBOAT_KIND="$MODE" \
    LIFEBOAT_STARTED_AT="$STARTED_AT" \
    LIFEBOAT_DUMP_BYTES="$DUMP_BYTES" \
    LIFEBOAT_STORAGE_OBJECTS="$STORAGE_OBJECTS" \
    LIFEBOAT_DELETED_OBJECTS="$DELETED_OBJECTS" \
    LIFEBOAT_ERROR="$LIFEBOAT_ERROR" \
    RETENTION_DAYS="$RETENTION_DAYS" \
    node "$ROOT/scripts/checkin.mjs" || status=1
  exit "$status"
}
trap report EXIT

if [[ -n "${DATABASE_URL:-}" && -n "${RESTORE_DATABASE_URL:-}" && "$DATABASE_URL" == "$RESTORE_DATABASE_URL" ]]; then
  fail "Refusing to restore into DATABASE_URL."
fi

postgres_host() {
  local rest="${1-}"
  rest="${rest#*://}"
  if [[ "$rest" == *"@"* ]]; then
    rest="${rest#*@}"
  fi
  rest="${rest%%/*}"
  rest="${rest%%\?*}"
  if [[ "$rest" == \[*\]* ]]; then
    rest="${rest#\[}"
    rest="${rest%%\]*}"
  else
    rest="${rest%%:*}"
  fi
  printf '%s' "${rest,,}"
}

postgres_user() {
  local rest="${1-}"
  rest="${rest#*://}"
  if [[ "$rest" != *"@"* ]]; then
    printf '%s' ""
    return
  fi
  local userinfo="${rest%%@*}"
  local user="${userinfo%%:*}"
  user="${user//%2E/.}"
  user="${user//%2e/.}"
  printf '%s' "$user"
}

if [[ -n "${DATABASE_URL:-}" ]]; then
  db_host="$(postgres_host "$DATABASE_URL")"
  if [[ "$db_host" == db.*.supabase.co ]]; then
    fail "DATABASE_URL uses the direct Supabase host db.<project-ref>.supabase.co. That host is IPv6-only, and GitHub-hosted runners fail with Network is unreachable. Use the Session pooler URL on port 5432 (a host like aws-0-<region>.pooler.supabase.com). Do not use the transaction pooler on port 6543."
  fi
  if [[ "$db_host" == *.pooler.supabase.com ]]; then
    db_user="$(postgres_user "$DATABASE_URL")"
    if [[ ! "$db_user" =~ ^[A-Za-z_][A-Za-z0-9_]*\.[a-z]{20}$ ]]; then
      fail "The Session pooler username must include the project ref, like lastgood_backup.<project-ref>, not the role name alone. Do not use port 6543."
    fi
    unset db_user
  fi
fi

if [[ -z "$BUCKET" || -z "$AWS_ACCESS_KEY_ID" || -z "$AWS_SECRET_ACCESS_KEY" ]]; then
  fail "Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY."
fi
command -v aws >/dev/null || fail "The AWS CLI is not installed on this runner."
command -v node >/dev/null || fail "Node.js is not installed on this runner."

# GitHub-hosted runners ship an older pg_dump on PATH. Use the client installed for this major.
PG_DIR="${LIFEBOAT_PG_BIN:-/usr/lib/postgresql/${POSTGRES_MAJOR:-17}/bin}"
if [[ -x "${PG_DIR}/pg_dump" && -x "${PG_DIR}/pg_restore" && -x "${PG_DIR}/psql" ]]; then
  PG_DUMP="${PG_DIR}/pg_dump"
  PG_RESTORE="${PG_DIR}/pg_restore"
  PSQL="${PG_DIR}/psql"
else
  PG_DUMP="pg_dump"
  PG_RESTORE="pg_restore"
  PSQL="psql"
fi

client_major() {
  local version major
  version="$("$1" --version 2>/dev/null || true)"
  if [[ "$version" =~ ([0-9]+)\.[0-9]+ ]]; then
    major="${BASH_REMATCH[1]}"
    printf '%s' "$major"
  fi
}

# pg_dump refuses a newer server. Say so before it aborts, and do not print the URL.
assert_client_can_read() {
  local url="$1"
  local client server_num server_major
  client="$(client_major "$PG_DUMP")"
  [[ -n "$client" ]] || return 0
  if [[ ! -x "$PSQL" ]] && ! command -v "$PSQL" >/dev/null 2>&1; then
    return 0
  fi
  server_num="$("$PSQL" "$url" --no-psqlrc --tuples-only --no-align --command "SHOW server_version_num" 2>/dev/null || true)"
  server_num="${server_num//[^0-9]/}"
  [[ "$server_num" =~ ^[0-9]{5,6}$ ]] || return 0
  server_major=$((server_num / 10000))
  if [[ "$server_major" -gt "$client" ]]; then
    fail "pg_dump ${client} cannot read Postgres ${server_major}. The database is newer than the client on this runner. Install postgresql-client-${server_major} and use /usr/lib/postgresql/${server_major}/bin/pg_dump. The runner's default pg_dump is older and is the wrong binary."
  fi
}

encrypt_file() {
  local source="$1"
  local dest="$2"
  if [[ "$ENCRYPT" != "true" ]]; then
    cp "$source" "$dest"
    return
  fi
  if [[ -z "${LIFEBOAT_ENCRYPTION_PASSPHRASE:-}" ]]; then
    fail "Set LIFEBOAT_ENCRYPTION_PASSPHRASE. Generate it in this repository and keep it. LastGood does not have it."
  fi
  command -v openssl >/dev/null || fail "openssl is not installed on this runner."
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:LIFEBOAT_ENCRYPTION_PASSPHRASE -in "$source" -out "$dest"
}

decrypt_file() {
  local source="$1"
  local dest="$2"
  if [[ -z "${LIFEBOAT_ENCRYPTION_PASSPHRASE:-}" ]]; then
    fail "Set LIFEBOAT_ENCRYPTION_PASSPHRASE. The dump was encrypted with the passphrase kept in this repository."
  fi
  command -v openssl >/dev/null || fail "openssl is not installed on this runner."
  openssl enc -d -aes-256-cbc -pbkdf2 -salt -pass env:LIFEBOAT_ENCRYPTION_PASSPHRASE -in "$source" -out "$dest"
}

apply_retention() {
  if [[ "$MANAGE_RETENTION" != "true" ]]; then
    echo "Retention is left to the bucket. This key does not delete objects."
    return
  fi
  local list="$WORKDIR/objects.json"
  aws_s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "${PREFIX}/" --output json >"$list"
  local key
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    aws_s3 s3 rm "s3://${BUCKET}/${key}"
    DELETED_OBJECTS=$((DELETED_OBJECTS + 1))
  done < <(node "$ROOT/scripts/retention.mjs" "$list" "$RETENTION_DAYS")
}

latest_dump_key() {
  local list="$WORKDIR/dumps.json"
  aws_s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "${PREFIX}/db/" --output json >"$list"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const payload = JSON.parse(readFileSync(process.argv[1], "utf8"));
    const keys = (payload.Contents || []).map((item) => item.Key).filter((key) => key && (key.endsWith(".backup") || key.endsWith(".backup.enc")));
    keys.sort();
    if (keys.length === 0) process.exit(2);
    process.stdout.write(keys[keys.length - 1]);
  ' "$list"
}

copy_storage() {
  if [[ -z "${STORAGE_S3_ENDPOINT:-}" || -z "${STORAGE_S3_ACCESS_KEY_ID:-}" || -z "${STORAGE_S3_SECRET_ACCESS_KEY:-}" ]]; then
    echo "Storage copy skipped. Set STORAGE_S3_ENDPOINT and the storage S3 keys to include buckets."
    return
  fi
  local storage_region="${STORAGE_S3_REGION:-us-east-1}"
  local names
  names="$(
    AWS_ACCESS_KEY_ID="$STORAGE_S3_ACCESS_KEY_ID" \
      AWS_SECRET_ACCESS_KEY="$STORAGE_S3_SECRET_ACCESS_KEY" \
      AWS_DEFAULT_REGION="$storage_region" \
      aws --endpoint-url "$STORAGE_S3_ENDPOINT" s3 ls | awk '{print $3}'
  )"
  local name dest
  for name in $names; do
    dest="$WORKDIR/storage/$name"
    mkdir -p "$dest"
    AWS_ACCESS_KEY_ID="$STORAGE_S3_ACCESS_KEY_ID" \
      AWS_SECRET_ACCESS_KEY="$STORAGE_S3_SECRET_ACCESS_KEY" \
      AWS_DEFAULT_REGION="$storage_region" \
      aws --endpoint-url "$STORAGE_S3_ENDPOINT" s3 sync "s3://${name}" "$dest"
    if [[ "$ENCRYPT" != "true" ]]; then
      aws_s3 s3 sync "$dest" "s3://${BUCKET}/${PREFIX}/storage/${name}"
    fi
    STORAGE_OBJECTS=$((STORAGE_OBJECTS + $(find "$dest" -type f | wc -l)))
  done
  if [[ "$ENCRYPT" == "true" ]]; then
    mkdir -p "$WORKDIR/storage"
    tar -C "$WORKDIR/storage" -cf "$WORKDIR/storage.tar" .
    encrypt_file "$WORKDIR/storage.tar" "$WORKDIR/storage.tar.enc"
    aws_s3 s3 cp "$WORKDIR/storage.tar.enc" "s3://${BUCKET}/${PREFIX}/storage/${STAMP}.tar.enc"
  fi
}

if [[ "$MODE" == "backup" ]]; then
  [[ -n "${DATABASE_URL:-}" ]] || fail "Set DATABASE_URL. Use the Supabase Session pooler on port 5432 (aws-*.pooler.supabase.com), not the direct db.*.supabase.co host and not the transaction pooler on port 6543."
  [[ -x "$PG_DUMP" ]] || command -v "$PG_DUMP" >/dev/null || fail "pg_dump is not installed. The workflow should install postgresql-client."
  assert_client_can_read "$DATABASE_URL"
  # Read-only. pg_dump does not write to the source database.
  "$PG_DUMP" "$DATABASE_URL" --format=custom --no-owner --no-acl --file "$WORKDIR/dump.backup"
  DUMP_BYTES="$(wc -c <"$WORKDIR/dump.backup" | tr -d ' ')"
  if [[ "$ENCRYPT" == "true" ]]; then
    encrypt_file "$WORKDIR/dump.backup" "$WORKDIR/dump.backup.enc"
    aws_s3 s3 cp "$WORKDIR/dump.backup.enc" "s3://${BUCKET}/${PREFIX}/db/${STAMP}.backup.enc"
  else
    aws_s3 s3 cp "$WORKDIR/dump.backup" "s3://${BUCKET}/${PREFIX}/db/${STAMP}.backup"
  fi
  copy_storage
  apply_retention
elif [[ "$MODE" == "restore-test" ]]; then
  [[ -n "${RESTORE_DATABASE_URL:-}" ]] || fail "Set RESTORE_DATABASE_URL to the throwaway Postgres in this runner."
  [[ -x "$PG_RESTORE" ]] || command -v "$PG_RESTORE" >/dev/null || fail "pg_restore is not installed."
  [[ -x "$PSQL" ]] || command -v "$PSQL" >/dev/null || fail "psql is not installed."
  key="$(latest_dump_key)" || fail "No .backup object was found under ${PREFIX}/db/."
  aws_s3 s3 cp "s3://${BUCKET}/${key}" "$WORKDIR/restore.download"
  if [[ "$key" == *.enc ]]; then
    decrypt_file "$WORKDIR/restore.download" "$WORKDIR/restore.backup"
    rm -f "$WORKDIR/restore.download"
  else
    mv "$WORKDIR/restore.download" "$WORKDIR/restore.backup"
  fi
  DUMP_BYTES="$(wc -c <"$WORKDIR/restore.backup" | tr -d ' ')"
  avail_kb="$(df -Pk "$WORKDIR" | awk 'NR==2 {print $4}')"
  echo "Restore disk free: ${avail_kb} KiB. Dump bytes: ${DUMP_BYTES}."
  if [[ "$avail_kb" =~ ^[0-9]+$ ]] && (( avail_kb * 1024 < DUMP_BYTES )); then
    fail "Not enough free disk to restore this dump."
  fi
  assert_client_can_read "$RESTORE_DATABASE_URL"
  "$PG_RESTORE" --list "$WORKDIR/restore.backup" >"$WORKDIR/restore.toc"
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT nspname FROM pg_namespace" >"$WORKDIR/schemas.txt"
  node "$ROOT/scripts/restore-list.mjs" drop-sql "$WORKDIR/restore.toc" "$WORKDIR/schemas.txt" "$WORKDIR/drop.sql"
  if [[ -s "$WORKDIR/drop.sql" ]]; then
    "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=1 --file "$WORKDIR/drop.sql"
  fi
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT name FROM pg_available_extensions" >"$WORKDIR/extensions.txt"
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT nspname FROM pg_namespace" >"$WORKDIR/schemas.txt"
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT extname FROM pg_extension" >"$WORKDIR/installed.txt"
  node "$ROOT/scripts/restore-list.mjs" filter "$WORKDIR/restore.toc" "$WORKDIR/extensions.txt" "$WORKDIR/restore.list" "$WORKDIR/restore.skip.json" "$WORKDIR/schemas.txt" "$WORKDIR/installed.txt"
  set +e
  "$PG_RESTORE" --dbname "$RESTORE_DATABASE_URL" --no-owner --no-acl -L "$WORKDIR/restore.list" "$WORKDIR/restore.backup" >"$WORKDIR/restore.out" 2>"$WORKDIR/restore.err"
  restore_status=$?
  set -e
  node "$ROOT/scripts/restore-list.mjs" classify "$WORKDIR/restore.err" "$WORKDIR/restore.skip.json" "$restore_status"
  LIFEBOAT_PSQL="$PSQL" LIFEBOAT_PG_RESTORE="$PG_RESTORE" \
    node "$ROOT/scripts/restore-list.mjs" sample "$WORKDIR/restore.toc" "$WORKDIR/restore.skip.json" "$WORKDIR/restore.backup"
  rm -f "$WORKDIR/restore.backup"
  "$PSQL" "$RESTORE_DATABASE_URL" --set ON_ERROR_STOP=1 --command "SELECT current_database();"
else
  fail "LIFEBOAT_MODE must be backup or restore-test."
fi
