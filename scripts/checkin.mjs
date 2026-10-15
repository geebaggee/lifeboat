import { signCheckin } from "../src/sign-checkin.mjs";

const secret = process.env.CHECKIN_SECRET?.trim() ?? "";
const url = (process.env.CHECKIN_URL || "https://lastgood.app/api/checkin").trim();
if (!secret) {
  console.log("Check-in skipped: CHECKIN_SECRET is not set.");
  process.exit(0);
}

const body = JSON.stringify({
  version: 1,
  ok: process.env.LIFEBOAT_OK === "true",
  kind: process.env.LIFEBOAT_KIND === "restore-test" ? "restore-test" : "backup",
  project: (process.env.LIFEBOAT_PROJECT || "").slice(0, 80),
  startedAt: process.env.LIFEBOAT_STARTED_AT || null,
  finishedAt: new Date().toISOString(),
  dumpBytes: numberEnv("LIFEBOAT_DUMP_BYTES"),
  storageObjects: numberEnv("LIFEBOAT_STORAGE_OBJECTS"),
  retentionDays: numberEnv("RETENTION_DAYS"),
  deletedObjects: numberEnv("LIFEBOAT_DELETED_OBJECTS"),
  error: process.env.LIFEBOAT_ERROR ? process.env.LIFEBOAT_ERROR.slice(0, 300) : null,
});

const timestamp = String(Math.floor(Date.now() / 1000));
const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "User-Agent": "LastGood-lifeboat/0.1 (+https://lastgood.app)",
    "X-LastGood-Timestamp": timestamp,
    "X-LastGood-Signature": signCheckin(secret, timestamp, body),
  },
  body,
});

if (!response.ok) {
  const text = (await response.text()).slice(0, 180);
  console.error(`Check-in failed (${response.status}). ${text}`);
  process.exit(1);
}
console.log(`Check-in accepted (${response.status}).`);

function numberEnv(name) {
  const value = Number(process.env[name] ?? "0");
  return Number.isFinite(value) ? value : 0;
}
