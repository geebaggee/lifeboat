const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Keys whose LastModified is older than the retention window.
 * Unparseable dates are kept. Prefix folders are kept.
 */
export function keysToDelete(objects, retentionDays, nowMs = Date.now()) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 1) {
    throw new Error("Retention days must be a positive number.");
  }
  const cutoff = nowMs - days * DAY_MS;
  const keys = [];
  for (const object of objects) {
    if (!object || typeof object.key !== "string" || object.key.endsWith("/")) continue;
    const modified = Date.parse(object.lastModified);
    if (!Number.isFinite(modified) || modified >= cutoff) continue;
    keys.push(object.key);
  }
  return keys;
}

export function objectsFromList(payload) {
  const contents = payload && Array.isArray(payload.Contents) ? payload.Contents : [];
  return contents
    .filter((item) => item && typeof item.Key === "string")
    .map((item) => ({ key: item.Key, lastModified: item.LastModified ?? "" }));
}
