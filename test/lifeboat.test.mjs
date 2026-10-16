import assert from "node:assert/strict";
import { test } from "node:test";
import { keysToDelete, objectsFromList } from "../src/retention.mjs";
import {
  classifyRestoreErrors,
  countCopyRows,
  filterRestoreList,
  sanitiseRestoreLine,
  selectSampleTables,
  verifySampleCounts,
} from "../scripts/restore-list.mjs";
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

const TOC = `
;
; Selected TOC Entries:
;
2; 3079 16384 EXTENSION - plpgsql postgres
3; 3079 16385 EXTENSION - pg_cron postgres
4; 3079 16386 EXTENSION - pg_net postgres
5; 3079 16387 EXTENSION - pgsodium postgres
6; 3079 16388 EXTENSION - supabase_vault postgres
7; 3079 16389 EXTENSION - vector postgres
10; 2615 2200 SCHEMA - public postgres
11; 2615 2201 SCHEMA - cron postgres
12; 2615 2202 SCHEMA - vault postgres
20; 1259 3000 TABLE public widgets postgres
21; 1259 3001 TABLE cron job postgres
22; 1259 3002 TABLE DATA public widgets postgres
23; 1259 3003 TABLE DATA cron job postgres
24; 1259 3004 TABLE DATA vault secrets postgres
25; 1259 3005 TABLE DATA public huge postgres
30; 0 0 COMMENT - EXTENSION pg_cron postgres
31; 0 0 COMMENT public TABLE widgets postgres
40; 1259 3006 ACL public TABLE widgets postgres
`;

test("restore list comments extensions the target does not offer, and objects in their schemas", () => {
  const result = filterRestoreList(TOC, ["plpgsql", "vector"]);
  assert.deepEqual(result.skippedExtensions, ["pg_cron", "pg_net", "pgsodium", "supabase_vault"]);
  assert.deepEqual(result.skippedSchemas, ["cron", "net", "pgsodium", "vault"]);
  assert.match(result.text, /^2; 3079 16384 EXTENSION - plpgsql postgres$/m);
  assert.match(result.text, /^7; 3079 16389 EXTENSION - vector postgres$/m);
  assert.match(result.text, /^;3; 3079 16385 EXTENSION - pg_cron postgres$/m);
  assert.match(result.text, /^;11; 2615 2201 SCHEMA - cron postgres$/m);
  assert.match(result.text, /^;21; 1259 3001 TABLE cron job postgres$/m);
  assert.match(result.text, /^;23; 1259 3003 TABLE DATA cron job postgres$/m);
  assert.match(result.text, /^;24; 1259 3004 TABLE DATA vault secrets postgres$/m);
  assert.match(result.text, /^;30; 0 0 COMMENT - EXTENSION pg_cron postgres$/m);
  assert.match(result.text, /^20; 1259 3000 TABLE public widgets postgres$/m);
  assert.match(result.text, /^22; 1259 3002 TABLE DATA public widgets postgres$/m);
  assert.match(result.text, /^31; 0 0 COMMENT public TABLE widgets postgres$/m);
  assert.match(result.text, /^40; 1259 3006 ACL public TABLE widgets postgres$/m);
});

test("extension errors are warnings and copy errors fail", () => {
  const skipped = { extensions: ["pg_cron", "supabase_vault"], schemas: ["cron", "vault"] };
  const warned = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR:  extension "pg_cron" is not available\n',
    skipped,
  );
  assert.deepEqual(warned.fatal, []);
  assert.equal(warned.warnings.length, 1);
  const copied = classifyRestoreErrors(
    "pg_restore: error: COPY failed for table \"widgets\": ERROR: invalid input syntax for type integer\n",
    skipped,
  );
  assert.equal(copied.fatal.length, 1);
  assert.deepEqual(copied.warnings, []);
  const url = sanitiseRestoreLine(
    "pg_restore: error: connection to server failed: postgresql://postgres:throwaway@localhost:5432/restore",
  );
  assert.equal(url.includes("throwaway"), false);
  assert.match(url, /postgresql:\/\/redacted/);
});

test("row-count sample prefers a small public table and compares copy lines", async () => {
  const tables = selectSampleTables(TOC, { schemas: ["cron", "vault"] }, 3);
  assert.deepEqual(
    tables.map((table) => `${table.schema}.${table.table}`),
    ["public.widgets", "public.huge"],
  );
  assert.equal(countCopyRows("COPY public.widgets (id) FROM stdin;\n1\n2\n\\.\n"), 2);
  assert.equal(countCopyRows("no copy here\n"), null);
  const calls = [];
  await verifySampleCounts({
    toc: TOC,
    skipped: { schemas: ["cron", "vault"] },
    dumpPath: "/tmp/restore.backup",
    psql: "psql",
    pgRestore: "pg_restore",
    databaseUrl: "postgresql://postgres:throwaway@localhost/restore",
    spawnImpl(command, args) {
      calls.push([command, args]);
      const sql = String(args.at(-1) ?? "");
      let body = "100\n";
      if (sql.includes("huge")) body = `${33 * 1024 * 1024}\n`;
      if (sql.startsWith("SELECT count")) body = "2\n";
      if (command === "pg_restore") body = "COPY public.widgets (id) FROM stdin;\n1\n2\n\\.\n";
      return {
        stdout: { on(event, fn) { if (event === "data") fn(body); } },
        stderr: { on() {} },
        on(event, fn) { if (event === "close") fn(0); },
      };
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(calls[0][0], "psql");
  assert.match(calls[0][1].at(-1), /widgets/);
  assert.deepEqual(calls[2][1].slice(0, 6), ["-a", "-n", "public", "-t", "widgets", "-f"]);
  assert.match(String(calls[3][1].at(-1)), /huge/);
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
