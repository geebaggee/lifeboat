# Lifeboat

Nightly backup of a Supabase (or any Postgres) database, plus storage objects, to S3-compatible storage. Once a month it restores the newest dump into a throwaway Postgres on the GitHub Actions runner and posts a signed status to LastGood.

This folder is the action. It does not import the LastGood website. It can be moved into its own public repository without the rest of this repo. A licence for that repository is Nick's choice; this folder does not pretend one has been chosen yet.

## What a run does

`backup`:

1. `pg_dump` in custom format, without owners or ACLs, so the dump includes application schemas and `auth`.
2. Uploads `lifeboat/db/<timestamp>.backup` to the destination bucket.
3. If storage S3 credentials are set, copies each source bucket into `lifeboat/storage/<bucket>/`.
4. Deletes destination objects under the prefix that are older than the retention window. The default is 30 days.
5. Posts a signed check-in. The database URL and the storage keys are not in that body.

`restore-test`:

1. Downloads the newest `.backup` under the prefix.
2. `pg_restore` into `RESTORE_DATABASE_URL` with `--exit-on-error`.
3. Runs `SELECT current_database()` against that database.
4. Posts a check-in with `kind` `restore-test`.

The throwaway database is thrown away with the runner. It is not a second backup.

## Sydney is the default

Leave the endpoint and region unset and the action uses Sydney, Australia (`ap-southeast-2`). Backups are stored in the region you choose when those values are set. Any S3-compatible API works. Create an access key that can list, put and delete objects in one bucket. Do not use the root account key if you can avoid it. Hosted storage sets the endpoint for you and turns deletion off, because the bucket keeps the objects.

### Amazon S3

Set the endpoint to the regional S3 endpoint, for example `https://s3.ap-southeast-2.amazonaws.com`, and the region to `ap-southeast-2`.

### Cloudflare R2

Set the endpoint to `https://<account-id>.r2.cloudflarestorage.com` and the region to `auto`. The action sets path-style addressing, which R2 expects. Create an R2 token that can read and write the bucket.

## Supabase database URL

For Supabase, LastGood can write `DATABASE_URL` after you connect the project. The URL is the Session pooler on port 5432. The username must include the project ref, like `lastgood_backup.<project-ref>`. The host looks like `aws-0-<region>.pooler.supabase.com`. Do not use the direct host `db.<project-ref>.supabase.co`. That host is IPv6-only, and GitHub-hosted runners fail with `Network is unreachable`. Do not use the transaction pooler on port 6543. A manual URL is the fallback. LastGood writes the secret and does not keep a copy.

## Storage objects

Supabase Storage can expose an S3 endpoint. In Storage → S3, create an access key and set:

| Variable | Example |
|---|---|
| `SUPABASE_STORAGE_S3_ENDPOINT` | the endpoint Supabase shows |
| `SUPABASE_STORAGE_S3_REGION` | the region Supabase shows for that endpoint |
| `SUPABASE_STORAGE_S3_ACCESS_KEY_ID` | the access key |
| `SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY` | the secret |

If those are empty, the database dump still runs and the log says storage was skipped. Objects are downloaded to the runner and uploaded to the destination. A very large bucket needs a runner with enough disk.

## Check-in

When `CHECKIN_SECRET` is set, the action `POST`s JSON to `https://lastgood.app/api/checkin` (override with `CHECKIN_URL`).

Headers:

- `X-LastGood-Timestamp`: unix seconds
- `X-LastGood-Signature`: hex HMAC-SHA256 of `${timestamp}.${rawBody}` using the secret

The body is the raw JSON that was signed. A signature older than five minutes, or one that does not match the bytes, must be rejected. The JSON has `version`, `ok`, `kind` (`backup` or `restore-test`), `project`, `startedAt`, `finishedAt`, `dumpBytes`, `storageObjects`, `retentionDays`, `deletedObjects` and `error`. It does not contain the database URL, keys, or row data.

`project` should be a stable id, such as the Supabase project ref, so an alert can name the app. v1 uses one shared `CHECKIN_SECRET` on the action and on LastGood. Anyone with that secret can send a check-in.

If the secret is empty, the backup still runs and the check-in is skipped.

## Workflow

`templates/lifeboat.yml` is the workflow to copy into the app repository at `.github/workflows/lifeboat.yml`.

GitHub variables:

| Name | Purpose |
|---|---|
| `LIFEBOAT_PROJECT` | Supabase project ref, or another stable name |
| `LIFEBOAT_BUCKET` | Destination bucket |
| `SUPABASE_STORAGE_S3_ENDPOINT` | Optional |
| `SUPABASE_STORAGE_S3_REGION` | Optional |

The template passes the destination variables. When they are empty, the action uses Sydney, Australia (`ap-southeast-2`) and keeps objects for 30 days. For Amazon S3, Cloudflare R2, another region, or a different retention, set `s3-endpoint`, `s3-region` and `retention-days`.

GitHub secrets:

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Session pooler Postgres URL on port 5432. Username is `role.project-ref`. Not `db.*.supabase.co`. |
| `LIFEBOAT_ACCESS_KEY_ID` | Destination access key |
| `LIFEBOAT_SECRET_ACCESS_KEY` | Destination secret key |
| `SUPABASE_STORAGE_S3_ACCESS_KEY_ID` | Optional source key |
| `SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY` | Optional source secret |
| `LIFEBOAT_CHECKIN_SECRET` | Same value as LastGood's check-in secret |

Scheduled workflows stop after 60 days without a repository commit. That is GitHub's rule. The check-in is how LastGood notices the silence; the receiver is a separate change.

If `pg_restore` fails because an extension is missing, change the throwaway image in the workflow. `postgres:17` is the default. It does not include every Supabase extension. The dump uses `pg_dump` against `DATABASE_URL` and does not write to that database. Restore writes only to `RESTORE_DATABASE_URL`. The dump is encrypted on the runner before upload. Secret values are masked and are not printed.

## Publish this folder on its own

1. Create an empty public repository, for example `geebaggee/lifeboat`.
2. Copy this directory to the root of that repository, including `action.yml`.
3. Publish a new release tag, such as `v1.0.1`. Do not move an existing tag.
4. In customer workflows, pin the full commit of that tag: `uses: geebaggee/lifeboat@<40-character sha> # v1.0.1`. Do not pin the movable tag.

## Tests

From the LastGood repository root, `npm test` runs `node --test lifeboat/test`. From this folder alone:

```bash
node --test test/lifeboat.test.mjs
```

The tests cover retention and the check-in signature. They do not call the destination storage, Supabase or GitHub.
