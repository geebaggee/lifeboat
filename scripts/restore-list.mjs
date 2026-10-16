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

/** Schemas a stock or Supabase image already has, and that the dump must reuse. */
const KEPT_SCHEMAS = new Set(["public", "information_schema"]);

function extensionSchemaNames() {
  const names = new Set(["extensions"]);
  for (const schemas of Object.values(EXTENSION_SCHEMAS)) {
    for (const schema of schemas) names.add(schema);
  }
  return names;
}

const EXTENSION_SCHEMA_NAMES = extensionSchemaNames();

export function schemasToDrop(_toc, existingNames) {
  return identList(existingNames).filter((name) => !keptSchema(name));
}

export function dropSchemaSql(names) {
  return (names ?? [])
    .filter((name) => simpleIdent(name) && !keptSchema(name))
    .map((name) => `DROP SCHEMA IF EXISTS ${name} CASCADE;`)
    .join("\n");
}

const ROLE_SQL = `DO $lifeboat_roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'supabase_admin', 'authenticator']
  LOOP
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', role_name);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'lifeboat role skipped: %', SQLERRM;
    END;
  END LOOP;
END
$lifeboat_roles$;`;

/**
 * Clears public of objects the image or a previous test left behind.
 * Extension members stay. One object that will not drop does not stop the rest.
 */
const PUBLIC_SWEEP_SQL = `DO $lifeboat_public$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relkind, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
  LOOP
    BEGIN
      IF r.relkind IN ('r', 'p') THEN
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.relname);
      ELSIF r.relkind = 'v' THEN
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.relname);
      ELSIF r.relkind = 'm' THEN
        EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS public.%I CASCADE', r.relname);
      ELSIF r.relkind = 'S' THEN
        EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.relname);
      ELSE
        EXECUTE format('DROP FOREIGN TABLE IF EXISTS public.%I CASCADE', r.relname);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'lifeboat drop skipped: %', SQLERRM;
    END;
  END LOOP;
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END AS kind
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    BEGIN
      EXECUTE format('DROP %s IF EXISTS public.%I(%s) CASCADE', r.kind, r.proname, r.args);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'lifeboat drop skipped: %', SQLERRM;
    END;
  END LOOP;
  FOR r IN
    SELECT t.typname, CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END AS kind
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'c', 'd', 'r') AND t.typrelid = 0
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
      )
  LOOP
    BEGIN
      EXECUTE format('DROP %s IF EXISTS public.%I CASCADE', r.kind, r.typname);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'lifeboat drop skipped: %', SQLERRM;
    END;
  END LOOP;
END
$lifeboat_public$;`;

/**
 * SQL for a disposable restore target. Roles are created when missing.
 * Event triggers go first so they cannot block the drops. Publications go
 * next, then objects already in public, then every non-system schema except
 * public and schemas an extension owns. pg_* schemas stay.
 */
export function throwawayDropSql(toc, catalog = {}) {
  const eventTriggers = identList(catalog.eventTriggers);
  const publications = identList(catalog.publications);
  const schemas = schemasToDrop(toc, catalog.schemas);
  const publicObjects = publicObjectDrops(toc);
  const lines = [ROLE_SQL];
  for (const name of eventTriggers) {
    lines.push(`ALTER EVENT TRIGGER ${name} DISABLE;`);
    lines.push(`DROP EVENT TRIGGER IF EXISTS ${name};`);
  }
  for (const name of publications) lines.push(`DROP PUBLICATION IF EXISTS ${name};`);
  lines.push(...publicObjects);
  for (const name of schemas) lines.push(`DROP SCHEMA IF EXISTS ${name} CASCADE;`);
  lines.push(PUBLIC_SWEEP_SQL);
  return { sql: lines.join("\n"), eventTriggers, publications, schemas, publicObjects };
}

/** Objects in public that the dump recreates. public itself stays. */
function publicObjectDrops(toc) {
  const lines = [];
  const seen = new Set();
  for (const entry of String(toc).split("\n").map(parseTocLine)) {
    if (!entry || entry.namespace !== "public") continue;
    const statement = publicDropStatement(entry);
    if (!statement || seen.has(statement)) continue;
    seen.add(statement);
    lines.push(statement);
  }
  return lines;
}

function publicDropStatement(entry) {
  if (entry.desc === "TABLE" && simpleIdent(entry.tag)) return `DROP TABLE IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "VIEW" && simpleIdent(entry.tag)) return `DROP VIEW IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "MATERIALIZED VIEW" && simpleIdent(entry.tag)) return `DROP MATERIALIZED VIEW IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "SEQUENCE" && simpleIdent(entry.tag)) return `DROP SEQUENCE IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "TYPE" && simpleIdent(entry.tag)) return `DROP TYPE IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "DOMAIN" && simpleIdent(entry.tag)) return `DROP DOMAIN IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "FUNCTION" || entry.desc === "PROCEDURE" || entry.desc === "AGGREGATE") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\([^)]*\)$/.test(entry.tag) || /[;`]/.test(entry.tag)) return null;
    return `DROP ${entry.desc} IF EXISTS public.${entry.tag} CASCADE;`;
  }
  return null;
}

export function filterRestoreList(toc, availableNames, options = {}) {
  const available = nameSet(availableNames);
  const existingSchemas = nameSet(options.existingSchemas);
  const installed = nameSet(options.installedExtensions);
  const existingPublications = nameSet(options.existingPublications);
  const existingEventTriggers = nameSet(options.existingEventTriggers);
  const lines = String(toc).split("\n");
  const parsed = lines.map(parseTocLine);
  const skippedExtensions = new Set();
  const installedExtensions = new Set();
  for (const entry of parsed) {
    if (!entry || entry.desc !== "EXTENSION") continue;
    const name = entry.tag;
    if (!name || name === "-" || !simpleIdent(name)) continue;
    if (!available.has(name)) skippedExtensions.add(name);
    else if (installed.has(name)) installedExtensions.add(name);
  }
  const skippedSchemas = new Set();
  for (const name of skippedExtensions) {
    for (const schema of EXTENSION_SCHEMAS[name] ?? []) skippedSchemas.add(schema);
  }
  const preexistingSchemas = new Set();
  const preexistingPublications = new Set();
  const preexistingEventTriggers = new Set();
  for (const entry of parsed) {
    if (!entry) continue;
    if (entry.desc === "SCHEMA" && existingSchemas.has(entry.tag)) preexistingSchemas.add(entry.tag);
    if (entry.desc === "PUBLICATION" && existingPublications.has(entry.tag)) preexistingPublications.add(entry.tag);
    if (entry.desc === "EVENT TRIGGER" && existingEventTriggers.has(entry.tag)) preexistingEventTriggers.add(entry.tag);
  }
  const skipState = {
    unavailable: skippedExtensions,
    installed: installedExtensions,
    extensionSchemas: skippedSchemas,
    existingSchemas: preexistingSchemas,
    existingPublications: preexistingPublications,
    existingEventTriggers: preexistingEventTriggers,
  };
  const text = lines
    .map((line, index) => {
      const entry = parsed[index];
      if (!entry || !shouldSkip(entry, skipState)) return line;
      return line.startsWith(";") ? line : `;${line}`;
    })
    .join("\n");
  return {
    text,
    skippedExtensions: [...skippedExtensions].sort(),
    skippedSchemas: [...skippedSchemas].sort(),
    preexistingSchemas: [...preexistingSchemas].sort(),
    installedExtensions: [...installedExtensions].sort(),
    preexistingPublications: [...preexistingPublications].sort(),
    preexistingEventTriggers: [...preexistingEventTriggers].sort(),
  };
}

export function classifyRestoreErrors(stderr, skipped) {
  const extensions = new Set(skipped?.extensions ?? skipped?.skippedExtensions ?? []);
  const schemas = new Set(skipped?.schemas ?? skipped?.skippedSchemas ?? []);
  const preexisting = new Set(skipped?.preexisting ?? skipped?.preexistingSchemas ?? []);
  const installed = new Set(skipped?.installed ?? skipped?.installedExtensions ?? []);
  const fatal = [];
  const warnings = [];
  for (const line of String(stderr).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !/error:/i.test(trimmed)) continue;
    if (isDataError(trimmed)) fatal.push(trimmed);
    else if (isAlreadyExists(trimmed) || isExtensionWarning(trimmed, extensions, schemas) || isPreexistingObject(trimmed, preexisting, installed)) {
      warnings.push(trimmed);
    } else fatal.push(trimmed);
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

function nameSet(values) {
  return new Set((values ?? []).map((name) => String(name).trim()).filter((name) => name.length > 0));
}

function keptSchema(name) {
  return KEPT_SCHEMAS.has(name) || name.startsWith("pg_") || EXTENSION_SCHEMA_NAMES.has(name);
}

function shouldSkip(entry, state) {
  const extensions = new Set([...state.unavailable, ...state.installed]);
  if (entry.desc === "EXTENSION" && extensions.has(entry.tag)) return true;
  if (entry.desc === "PUBLICATION" && state.existingPublications.has(entry.tag)) return true;
  if (entry.desc === "EVENT TRIGGER" && state.existingEventTriggers.has(entry.tag)) return true;
  if (entry.desc === "COMMENT") {
    const named = entry.tag.match(/^(EXTENSION|SCHEMA|PUBLICATION|EVENT TRIGGER)\s+(\S+)$/);
    if (named?.[1] === "EXTENSION" && extensions.has(named[2])) return true;
    if (named?.[1] === "SCHEMA" && (state.extensionSchemas.has(named[2]) || state.existingSchemas.has(named[2]))) return true;
    if (named?.[1] === "PUBLICATION" && state.existingPublications.has(named[2])) return true;
    if (named?.[1] === "EVENT TRIGGER" && state.existingEventTriggers.has(named[2])) return true;
  }
  if (entry.desc === "SCHEMA" && (state.extensionSchemas.has(entry.tag) || state.existingSchemas.has(entry.tag))) return true;
  if (entry.namespace && state.extensionSchemas.has(entry.namespace)) return true;
  return false;
}

function identList(names) {
  return [...nameSet(names)].filter(simpleIdent).sort();
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

function isAlreadyExists(line) {
  return /already exists|already member of publication/i.test(line);
}

function isPreexistingObject(line, preexisting, installed) {
  const schema = line.match(/schema "([^"]+)" already exists/i);
  if (schema && preexisting.has(schema[1])) return true;
  const extension = line.match(/extension "([^"]+)" already exists/i);
  return Boolean(extension && installed.has(extension[1]));
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
    preexisting: Array.isArray(body.preexisting) ? body.preexisting : [],
    installed: Array.isArray(body.installed) ? body.installed : [],
    publications: Array.isArray(body.publications) ? body.publications : [],
    eventTriggers: Array.isArray(body.eventTriggers) ? body.eventTriggers : [],
  };
}

function readNames(path) {
  return path ? readFileSync(path, "utf8").split(/\s+/) : [];
}

async function runFilter(tocPath, extensionsPath, outPath, skipPath, schemasPath, installedPath, publicationsPath, eventTriggersPath) {
  const result = filterRestoreList(readFileSync(tocPath, "utf8"), readNames(extensionsPath), {
    existingSchemas: readNames(schemasPath),
    installedExtensions: readNames(installedPath),
    existingPublications: readNames(publicationsPath),
    existingEventTriggers: readNames(eventTriggersPath),
  });
  writeFileSync(outPath, result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  writeFileSync(
    skipPath,
    JSON.stringify({
      extensions: result.skippedExtensions,
      schemas: result.skippedSchemas,
      preexisting: result.preexistingSchemas,
      installed: result.installedExtensions,
      publications: result.preexistingPublications,
      eventTriggers: result.preexistingEventTriggers,
    }),
  );
  const names = result.skippedExtensions.join(", ");
  const kept = result.preexistingSchemas.join(", ");
  const publications = result.preexistingPublications.join(", ");
  const triggers = result.preexistingEventTriggers.join(", ");
  process.stdout.write(`Restore list skipped extensions: ${names || "none"}.\n`);
  process.stdout.write(`Restore list kept existing schemas: ${kept || "none"}.\n`);
  process.stdout.write(`Restore list kept existing publications: ${publications || "none"}.\n`);
  process.stdout.write(`Restore list kept existing event triggers: ${triggers || "none"}.\n`);
}

function runDropSql(tocPath, schemasPath, outPath, publicationsPath, eventTriggersPath) {
  const drop = throwawayDropSql(readFileSync(tocPath, "utf8"), {
    schemas: readNames(schemasPath),
    publications: readNames(publicationsPath),
    eventTriggers: readNames(eventTriggersPath),
  });
  writeFileSync(outPath, drop.sql ? `${drop.sql}\n` : "");
  process.stdout.write(`Throwaway event triggers to drop: ${drop.eventTriggers.join(", ") || "none"}.\n`);
  process.stdout.write(`Throwaway publications to drop: ${drop.publications.join(", ") || "none"}.\n`);
  process.stdout.write(`Throwaway schemas to drop: ${drop.schemas.join(", ") || "none"}.\n`);
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
  if (command === "drop-sql" && (args.length === 3 || args.length === 5)) {
    runDropSql(args[0], args[1], args[2], args[3], args[4]);
    return;
  }
  if (command === "filter" && (args.length === 4 || args.length === 6 || args.length === 8)) {
    await runFilter(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
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
  process.stderr.write("usage: restore-list.mjs drop-sql|filter|classify|sample\n");
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
