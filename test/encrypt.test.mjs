import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");

test("the runner encrypts with openssl and does not delete when retention is off", () => {
  const source = readFileSync(RUN, "utf8");
  assert.match(source, /openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:LIFEBOAT_ENCRYPTION_PASSPHRASE/);
  assert.match(source, /\.backup\.enc/);
  assert.match(source, /MANAGE_RETENTION" != "true"/);
  assert.match(source, /::add-mask::/);
  assert.match(source, /mask "\$\{DATABASE_URL:-\}"/);
  assert.match(source, /mask "\$\{LIFEBOAT_ENCRYPTION_PASSPHRASE:-\}"/);
  assert.match(source, /mask "\$\{CHECKIN_SECRET:-\}"/);
  assert.match(source, /pg_dump "\$DATABASE_URL" --format=custom --no-owner --no-acl/);
  assert.doesNotMatch(source, /psql "\$DATABASE_URL"/);
  assert.match(source, /pg_restore --dbname "\$RESTORE_DATABASE_URL"/);
  assert.match(source, /Refusing to restore into DATABASE_URL/);
  assert.match(source, /value_or "\$\{S3_ENDPOINT:-}" "https:\/\/s3\.ap-southeast-2\.wasabisys\.com"/);
});

test("openssl aes-256-cbc pbkdf2 round-trips with the env passphrase", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-enc-"));
  const plain = path.join(dir, "dump.backup");
  const enc = path.join(dir, "dump.backup.enc");
  const out = path.join(dir, "out.backup");
  writeFileSync(plain, "rows-stay-here");
  const env = { ...process.env, LIFEBOAT_ENCRYPTION_PASSPHRASE: "correct horse battery" };
  const flags = ["enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", "env:LIFEBOAT_ENCRYPTION_PASSPHRASE"];
  execFileSync("openssl", [...flags, "-in", plain, "-out", enc], { env });
  execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", "env:LIFEBOAT_ENCRYPTION_PASSPHRASE", "-in", enc, "-out", out], { env });
  assert.equal(readFileSync(out, "utf8"), "rows-stay-here");
});

function fakes(dir) {
  const awsLog = path.join(dir, "aws.log");
  const pg = path.join(dir, "pg_dump");
  const aws = path.join(dir, "aws");
  writeFileSync(
    pg,
    `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "--file" ]; then
    printf 'dump' > "$2"
    exit 0
  fi
  shift
done
exit 1
`,
  );
  writeFileSync(
    aws,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${awsLog}"
case " $* " in
  *" s3api "*)
    printf '%s\\n' '{"Contents":[{"Key":"lifeboat/db/old.backup","LastModified":"2020-01-01T00:00:00.000Z"}]}'
    ;;
esac
exit 0
`,
  );
  chmodSync(pg, 0o755);
  chmodSync(aws, 0o755);
  writeFileSync(awsLog, "");
  return awsLog;
}

function runBackup(extra) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-run-"));
  const awsLog = fakes(dir);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const result = spawnSync("bash", [RUN], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      LIFEBOAT_MODE: "backup",
      DATABASE_URL: "postgres://example.invalid/db",
      S3_BUCKET: "lastgood-backups-ap-southeast-2",
      S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
      S3_ENDPOINT: "",
      S3_REGION: "",
      S3_PREFIX: "",
      CHECKIN_SECRET: "",
      LIFEBOAT_WORKDIR: work,
      ...extra,
    },
    encoding: "utf8",
  });
  const log = readFileSync(awsLog, "utf8");
  return { result, log };
}

test("an empty passphrase fails before upload", () => {
  const { result, log } = runBackup({ LIFEBOAT_ENCRYPT: "true", LIFEBOAT_ENCRYPTION_PASSPHRASE: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIFEBOAT_ENCRYPTION_PASSPHRASE/);
  assert.equal(log, "");
  assert.doesNotMatch(result.stderr, /unit-test-secret-not-real/);
});

test("empty destination vars use Sydney and hosted mode does not delete", () => {
  const byo = runBackup({
    LIFEBOAT_ENCRYPT: "false",
    LIFEBOAT_MANAGE_RETENTION: "",
  });
  assert.equal(byo.result.status, 0, byo.result.stderr);
  assert.match(byo.log, /--endpoint-url https:\/\/s3\.ap-southeast-2\.wasabisys\.com/);
  assert.match(byo.log, /\/lifeboat\/db\/.*\.backup$/m);
  assert.match(byo.log, /s3 rm/);

  const hosted = runBackup({
    LIFEBOAT_ENCRYPT: "true",
    LIFEBOAT_ENCRYPTION_PASSPHRASE: "keep-this-local",
    LIFEBOAT_MANAGE_RETENTION: "false",
    S3_ENDPOINT: "https://s3.eu-central-2.wasabisys.com",
    S3_REGION: "eu-central-2",
    S3_PREFIX: "cus_abc/app",
  });
  assert.equal(hosted.result.status, 0, hosted.result.stderr);
  assert.match(hosted.log, /--endpoint-url https:\/\/s3\.eu-central-2\.wasabisys\.com/);
  assert.match(hosted.log, /\.backup\.enc/);
  assert.doesNotMatch(hosted.log, /dump\.backup"/);
  assert.doesNotMatch(hosted.log, /s3 rm/);
  assert.doesNotMatch(hosted.log, /keep-this-local/);
  assert.match(hosted.result.stdout, /::add-mask::/);
  assert.doesNotMatch(hosted.result.stderr, /keep-this-local/);
  assert.doesNotMatch(hosted.result.stderr, /unit-test-secret-not-real/);
});
