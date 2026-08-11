/**
 * Durable per-file scan cache for the Claude session importer.
 *
 * A completed Claude transcript file is immutable once its CLI process exits,
 * so a `(path, size, mtime)` triple that has already been imported (or found to
 * carry nothing importable) can never yield a different outcome on a later
 * scan. Memoising that fact keeps repeated boot scans and project-open scans
 * cheap: a warm entry is a map lookup instead of a full re-parse + dedup read.
 *
 * This mirrors the shape of `usage/usageScanCache.ts` but is deliberately its
 * own module with its own, far simpler serialised form — the importer only
 * needs the `(size, mtime)` identity of each file, never the parsed records the
 * usage cache interns. Only *stable* outcomes are ever cached by the service:
 * a successful import, or a definitively-empty transcript. A transient read
 * failure, or a transcript skipped only because its project does not exist yet,
 * is never cached, so it is re-checked on the next scan.
 *
 * A malformed or version-mismatched document decodes to an empty cache rather
 * than throwing: a bad cache should cost one cold rescan, never a failed boot.
 *
 * @module importScanCache
 */

/** Bump when the cache key semantics change so stale entries are discarded. */
export const IMPORT_SCAN_CACHE_VERSION = 1 as const;

/** The identity of one cached transcript file. */
export interface CachedImportFile {
  readonly size: number;
  readonly mtimeMs: number;
}

/** In-memory cache: absolute transcript path → its `(size, mtime)` identity. */
export type ImportScanCache = Map<string, CachedImportFile>;

interface SerializedEntry {
  readonly s: number;
  readonly m: number;
}

interface SerializedCache {
  readonly version: number;
  readonly files: Readonly<Record<string, SerializedEntry>>;
}

/** Serialises the cache to a compact, JSON-friendly document. */
export function encodeImportScanCache(cache: ImportScanCache): SerializedCache {
  const files: Record<string, SerializedEntry> = {};
  for (const [path, entry] of cache) {
    files[path] = { s: entry.size, m: entry.mtimeMs };
  }
  return { version: IMPORT_SCAN_CACHE_VERSION, files };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Rebuilds the cache from a parsed document.
 *
 * Anything malformed or from a different cache version yields an empty cache:
 * a corrupt cache costs one cold scan, never a broken import.
 */
export function decodeImportScanCache(document: unknown): ImportScanCache {
  const cache: ImportScanCache = new Map();
  if (!isRecord(document)) return cache;
  if (document["version"] !== IMPORT_SCAN_CACHE_VERSION) return cache;

  const files = document["files"];
  if (!isRecord(files)) return cache;

  for (const [path, raw] of Object.entries(files)) {
    if (!isRecord(raw)) continue;
    const size = raw["s"];
    const mtimeMs = raw["m"];
    if (typeof size !== "number" || !Number.isFinite(size)) continue;
    if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) continue;
    cache.set(path, { size, mtimeMs });
  }

  return cache;
}
