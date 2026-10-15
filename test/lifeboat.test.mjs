import assert from "node:assert/strict";
import { test } from "node:test";
import { keysToDelete, objectsFromList } from "../src/retention.mjs";
import { signCheckin, verifyCheckin } from "../src/sign-checkin.mjs";

const NOW = Date.parse("2026-10-14T00:00:00.000Z");

test("retention deletes only objects older than the window", () => {
  const keys = keysToDelete(
    [
      { key: "lifeboat/db/old.backup", lastModified: "2026-08-01T00:00:00.000Z" },
      { key: "lifeboat/db/new.backup", lastModified: "2026-10-13T00:00:00.000Z" },
      { key: "lifeboat/db/", lastModified: "2026-01-01T00:00:00.000Z" },
      { key: "lifeboat/db/unknown.backup", lastModified: "not-a-date" },
    ],
    30,
    NOW,
  );
  assert.deepEqual(keys, ["lifeboat/db/old.backup"]);
});

test("retention reads the AWS list-objects shape", () => {
  const objects = objectsFromList({
    Contents: [{ Key: "lifeboat/db/a.backup", LastModified: "2026-01-01T00:00:00.000Z" }],
  });
  assert.equal(keysToDelete(objects, 30, NOW).length, 1);
});

test("check-in signatures expire and do not match another secret", () => {
  const body = JSON.stringify({ ok: true, kind: "backup" });
  const timestamp = String(Math.floor(NOW / 1000));
  const signature = signCheckin("secret", timestamp, body);
  assert.equal(verifyCheckin("secret", timestamp, body, signature, NOW), true);
  assert.equal(verifyCheckin("other", timestamp, body, signature, NOW), false);
  assert.equal(verifyCheckin("secret", timestamp, body, signature, NOW + 6 * 60 * 1000), false);
  assert.equal(verifyCheckin("secret", timestamp, `${body} `, signature, NOW), false);
});
