/**
 * Builds a pg_restore -L list that skips extensions the target does not offer,
 * and classifies leftover pg_restore errors.
 * A missing extension is a warning. A data error fails the restore test.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

/** Schemas created by extensions that pg_dump also emits as user objects. */
export const EXTENSION_SCHEMAS = {
  pg_cron: ["cron"],
  pg_net: ["net"],
  pgsodium: ["pgsodium"],
  supabase_vault: ["vault"],
  pg_graphql: ["graphql", "graphql_public"],
  pg_tle: ["pgtle"],
  wrappers: ["wrappers"],
  pgmq: ["pgmq"],
  timescaledb: [
    "_timescaledb_catalog",
    "_timescaledb_internal",
    "_timescaledb_cache",
    "_timescaledb_config",
    "timescaledb_experimental",
    "timescaledb_information",
  ],
};

const DESCRIPTIONS = [
  "MATERIALIZED VIEW DATA",
  "TEXT SEARCH CONFIGURATION",
  "TEXT SEARCH DICTIONARY",
  "TEXT SEARCH TEMPLATE",
  "TEXT SEARCH PARSER",
  "FOREIGN DATA WRAPPER",
  "MATERIALIZED VIEW",
  "PUBLICATION TABLE",
  "SEQUENCE OWNED BY",
  "PROCEDURAL LANGUAGE",
  "OPERATOR FAMILY",
  "OPERATOR CLASS",
  "USER MAPPING",
  "FK CONSTRAINT",
  "SEQUENCE SET",
  "DEFAULT ACL",
  "ROW SECURITY",
  "EVENT TRIGGER",
  "ACCESS METHOD",
  "LARGE OBJECT",
  "SHELL TYPE",
  "TABLE DATA",
  "PUBLICATION",
  "SUBSCRIPTION",
  "CONSTRAINT",
  "EXTENSION",
  "COLLATION",
  "CONVERSION",
  "AGGREGATE",
  "PROCEDURE",
  "TRANSFORM",
  "FUNCTION",
  "SEQUENCE",
  "COMMENT",
  "TRIGGER",
  "SCHEMA",
  "DOMAIN",
  "POLICY",
  "SERVER",
  "TABLE",
  "INDEX",
  "RULE",
  "CAST",
  "TYPE",
  "VIEW",
  "BLOB",
  "ACL",
];

const SAMPLE_LIMIT = 3;
const SAMPLE_BYTES = 32 * 1024 * 1024;
const SKIPPED_SYSTEM = new Set(["pg_catalog", "information_schema", "pg_toast"]);

export function filterRestoreList(toc, availableNames) {
  const available = new Set(
    (availableNames ?? []).map((name) => String(name).trim()).filter((name) => name.length > 0),
  );
  const lines = String(toc).split("\n");
  const parsed = lines.map(parseTocLine);
  const skippedExtensions = new Set();
  for (const entry of parsed) {
    if (!entry || entry.desc !== "EXTENSION") continue;
    const name = entry.tag;
    if (name && name !== "-" && !available.has(name)) skippedExtensions.add(name);
  }
  const skippedSchemas = new Set();
  for (const name of skippedExtensions) {
    for (const schema of EXTENSION_SCHEMAS[name] ?? []) skippedSchemas.add(schema);
  }
  const text = lines
    .map((line, index) => {
      const entry = parsed[index];
      if (!entry || !shouldSkip(entry, skippedExtensions, skippedSchemas)) return line;
      return line.startsWith(";") ? line : `;${line}`;
    })
    .join("\n");
  return {
    text,
    skippedExtensions: [...skippedExtensions].sort(),
    skippedSchemas: [...skippedSchemas].sort(),
  };
}

export function classifyRestoreErrors(stderr, skipped) {
  const extensions = new Set(skipped?.extensions ?? skipped?.skippedExtensions ?? []);
  const schemas = new Set(skipped?.schemas ?? skipped?.skippedSchemas ?? []);
  const fatal = [];
  const warnings = [];
  for (const line of String(stderr).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !/error:/i.test(trimmed)) continue;
    if (isDataError(trimmed)) fatal.push(trimmed);
    else if (isExtensionWarning(trimmed, extensions, schemas)) warnings.push(trimmed);
    else fatal.push(trimmed);
  }
  return { fatal, warnings };
}

export function selectSampleTables(toc, skipped, limit = SAMPLE_LIMIT) {
  const schemas = new Set(skipped?.schemas ?? skipped?.skippedSchemas ?? []);
  const found = [];
  const seen = new Set();
  for (const entry of String(toc).split("\n").map(parseTocLine)) {
    if (!entry || entry.desc !== "TABLE DATA") continue;
    if (!simpleIdent(entry.namespace) || !simpleIdent(entry.tag)) continue;
    if (SKIPPED_SYSTEM.has(entry.namespace) || schemas.has(entry.namespace)) continue;
    const key = `${entry.namespace}.${entry.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ schema: entry.namespace, table: entry.tag, preferred: entry.namespace === "public" });
  }
  found.sort((left, right) => Number(right.preferred) - Number(left.preferred));
  return found.slice(0, Math.max(0, limit));
}

export function countCopyRows(sql) {
  let counting = false;
  let count = 0;
  for (const line of String(sql).split("\n")) {
    if (!counting) {
      if (line.startsWith("COPY ")) counting = true;
      continue;
    }
    if (line === "\\.") return count;
    count += 1;
  }
  return counting ? count : null;
}

export function sanitiseRestoreLine(line) {
  return String(line)
    .replace(/postgresql:\/\/[^\s]+/gi, "postgresql://redacted")
    .replace(/:\/\/[^/\s:@]+:[^@\s]+@/g, "://redacted@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function shouldSkip(entry, extensions, schemas) {
  if (entry.desc === "EXTENSION" && extensions.has(entry.tag)) return true;
  if (entry.desc === "COMMENT") {
    const named = entry.tag.match(/^EXTENSION\s+(\S+)$/);
    if (named && extensions.has(named[1])) return true;
    const schemaComment = entry.tag.match(/^SCHEMA\s+(\S+)$/);
    if (schemaComment && schemas.has(schemaComment[1])) return true;
  }
  if (entry.desc === "SCHEMA" && schemas.has(entry.tag)) return true;
  if (entry.namespace && schemas.has(entry.namespace)) return true;
  return false;
}

function parseTocLine(line) {
  if (!line || line.startsWith(";") || !/^\d+;/.test(line)) return null;
  const match = line.match(/^\d+;\s+\d+\s+\d+\s+(.*\S)\s*$/);
  if (!match?.[1]) return null;
  const rest = match[1];
  let desc = null;
  for (const candidate of DESCRIPTIONS) {
    if (rest === candidate || rest.startsWith(`${candidate} `)) {
      desc = candidate;
      break;
    }
  }
  if (!desc) return null;
  const parts = rest.slice(desc.length).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const namespace = parts[0];
  const owner = parts.length >= 3 ? parts[parts.length - 1] : null;
  const tag = parts.length >= 3 ? parts.slice(1, -1).join(" ") : parts[1];
  return { desc, namespace, tag, owner };
}

function simpleIdent(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isDataError(line) {
  return /COPY failed|invalid input syntax|duplicate key value|extra data after last expected column|missing data for column|could not extend file|No space left on device|out of memory|connection to server|server closed the connection|password authentication failed|could not connect|too many connections/i.test(
    line,
  );
}

function isExtensionWarning(line, extensions, schemas) {
  const named = line.match(/extension "([^"]+)"/i);
  if (named && extensions.has(named[1])) return true;
  const schema = line.match(/schema "([^"]+)"/i);
  if (schema && schemas.has(schema[1])) return true;
  const qualified = line.match(/"([A-Za-z_][A-Za-z0-9_]*)\.[^"]*"/);
  if (qualified && schemas.has(qualified[1])) return true;
  for (const name of extensions) {
    if (name && line.includes(name)) return true;
  }
  return false;
}

function readSkipped(path) {
  const body = JSON.parse(readFileSync(path, "utf8"));
  return {
    extensions: Array.isArray(body.extensions) ? body.extensions : [],
    schemas: Array.isArray(body.schemas) ? body.schemas : [],
  };
}

async function runFilter(tocPath, extensionsPath, outPath, skipPath) {
  const available = readFileSync(extensionsPath, "utf8").split(/\s+/);
  const result = filterRestoreList(readFileSync(tocPath, "utf8"), available);
  writeFileSync(outPath, result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  writeFileSync(
    skipPath,
    JSON.stringify({ extensions: result.skippedExtensions, schemas: result.skippedSchemas }),
  );
  const names = result.skippedExtensions.join(", ");
  process.stdout.write(`Restore list skipped extensions: ${names || "none"}.\n`);
}

function runClassify(errPath, skipPath, statusText) {
  const status = Number(statusText);
  const result = classifyRestoreErrors(readFileSync(errPath, "utf8"), readSkipped(skipPath));
  for (const warning of result.warnings) {
    process.stdout.write(`Restore warning: ${sanitiseRestoreLine(warning)}\n`);
  }
  if (result.fatal.length > 0 || (status !== 0 && result.warnings.length === 0)) {
    const message = result.fatal[0] ? sanitiseRestoreLine(result.fatal[0]) : "pg_restore failed.";
    process.stderr.write(`Restore failed: ${message}\n`);
    process.exitCode = 1;
  }
}

function commandOutput(command, args, spawnImpl) {
  const run = spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    const child = run(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(sanitiseRestoreLine(stderr || `${command} failed.`)));
      else resolve(stdout);
    });
  });
}

export async function verifySampleCounts(options) {
  const tables = selectSampleTables(options.toc, options.skipped, 12).slice(0, 12);
  let checked = 0;
  for (const table of tables) {
    if (checked >= SAMPLE_LIMIT) break;
    const sizeSql = `SELECT COALESCE(pg_total_relation_size(format('%I.%I', '${table.schema}', '${table.table}')), -1)`;
    const sizeText = await commandOutput(
      options.psql,
      [options.databaseUrl, "--no-psqlrc", "--tuples-only", "--no-align", "--command", sizeSql],
      options.spawnImpl,
    );
    const size = Number(String(sizeText).trim());
    if (!Number.isFinite(size) || size < 0 || size > SAMPLE_BYTES) continue;
    const countSql = `SELECT count(*) FROM ${table.schema}.${table.table}`;
    const restoredText = await commandOutput(
      options.psql,
      [options.databaseUrl, "--no-psqlrc", "--tuples-only", "--no-align", "--command", countSql],
      options.spawnImpl,
    );
    const restored = Number(String(restoredText).trim());
    const archive = await commandOutput(
      options.pgRestore,
      ["-a", "-n", table.schema, "-t", table.table, "-f", "-", options.dumpPath],
      options.spawnImpl,
    );
    const dumped = countCopyRows(archive);
    if (!Number.isFinite(restored) || dumped === null) {
      throw new Error(`Row count for ${table.schema}.${table.table} could not be read.`);
    }
    if (restored !== dumped) {
      throw new Error(`Row count mismatch for ${table.schema}.${table.table}: restored ${restored}, dump ${dumped}.`);
    }
    checked += 1;
    process.stdout.write(`Row count matched for ${table.schema}.${table.table}: ${restored}.\n`);
  }
  if (checked === 0) {
    process.stdout.write("Row-count sample skipped: no small user table in the dump.\n");
  }
}

async function runSample(tocPath, skipPath, dumpPath) {
  const databaseUrl = process.env.RESTORE_DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("Set RESTORE_DATABASE_URL to the throwaway Postgres in this runner.");
  await verifySampleCounts({
    toc: readFileSync(tocPath, "utf8"),
    skipped: readSkipped(skipPath),
    dumpPath,
    psql: process.env.LIFEBOAT_PSQL || "psql",
    pgRestore: process.env.LIFEBOAT_PG_RESTORE || "pg_restore",
    databaseUrl,
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "filter" && args.length === 4) {
    await runFilter(args[0], args[1], args[2], args[3]);
    return;
  }
  if (command === "classify" && args.length === 3) {
    runClassify(args[0], args[1], args[2]);
    return;
  }
  if (command === "sample" && args.length === 3) {
    await runSample(args[0], args[1], args[2]);
    return;
  }
  process.stderr.write("usage: restore-list.mjs filter|classify|sample\n");
  process.exitCode = 1;
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("restore-list.mjs")) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Restore list failed.";
    process.stderr.write(`${sanitiseRestoreLine(message)}\n`);
    process.exitCode = 1;
  });
}
