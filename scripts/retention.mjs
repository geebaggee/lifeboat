import { readFileSync } from "node:fs";
import { keysToDelete, objectsFromList } from "../src/retention.mjs";

const file = process.argv[2];
const days = process.argv[3];
if (!file || !days) {
  console.error("Usage: node retention.mjs <list-objects.json> <retention-days>");
  process.exit(2);
}
const payload = JSON.parse(readFileSync(file, "utf8"));
for (const key of keysToDelete(objectsFromList(payload), days)) {
  process.stdout.write(`${key}\n`);
}
