// @effect-diagnostics nodeBuiltinImport:off
/**
 * Parsing and resolution for caam per-project default profiles.
 *
 * The server reads `T3CODE_CAAM_PROFILE_DEFAULTS` (a JSON array of
 * `{path, profile, tool?}`) and the single-default convenience
 * `T3CODE_CAAM_PROFILE_DEFAULT`. This module turns that raw configuration into
 * validated {@link CaamProjectDefault} records and resolves the best match for a
 * given working directory by longest path-prefix.
 *
 * These helpers are pure: they never throw and never touch Effect's runtime, so
 * they can be unit-tested directly and reused from the service layer.
 *
 * @module caam/ProjectDefaults
 */
import { CaamProjectDefault } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";

const decodeProjectDefault = Schema.decodeUnknownOption(CaamProjectDefault);

const DEFAULT_TOOL = "claude";

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse the configured per-project defaults.
 *
 * `rawJson` is the value of `T3CODE_CAAM_PROFILE_DEFAULTS` — a JSON array of
 * `{path, profile, tool?}` (tool defaults to `claude`). Malformed JSON, non-array
 * payloads, and individual entries missing a non-empty `path`/`profile` are
 * skipped rather than throwing. `path` is normalized with `node:path.resolve`.
 *
 * `singleDefault` is the value of `T3CODE_CAAM_PROFILE_DEFAULT`; when present it
 * is appended as a `claude` default rooted at `/`.
 */
export function parseProjectDefaults(
  rawJson: string | undefined,
  singleDefault: string | undefined,
): CaamProjectDefault[] {
  const results: CaamProjectDefault[] = [];

  const pushEntry = (pathValue: unknown, toolValue: unknown, profileValue: unknown): void => {
    const path = normalizedString(pathValue);
    const profile = normalizedString(profileValue);
    if (path === undefined || profile === undefined) {
      return;
    }
    const tool = normalizedString(toolValue) ?? DEFAULT_TOOL;
    const decoded = decodeProjectDefault({
      path: NodePath.resolve(path),
      tool,
      profile,
    });
    if (Option.isSome(decoded)) {
      results.push(decoded.value);
    }
  };

  if (rawJson !== undefined && rawJson.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry !== null && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          pushEntry(record.path, record.tool, record.profile);
        }
      }
    }
  }

  if (singleDefault !== undefined && singleDefault.trim().length > 0) {
    pushEntry("/", DEFAULT_TOOL, singleDefault);
  }

  return results;
}

/**
 * Return true when `prefix` is a directory-prefix of `target` on segment
 * boundaries: `/a/b` matches `/a/b` and `/a/b/c` but not `/a/bc`. Both inputs
 * must be normalized absolute paths.
 */
function isDirectoryPrefix(prefix: string, target: string): boolean {
  if (prefix === target) {
    return true;
  }
  const withSeparator = prefix.endsWith(NodePath.sep) ? prefix : `${prefix}${NodePath.sep}`;
  return target.startsWith(withSeparator);
}

/**
 * Among `defaults` matching `tool`, return the `profile` of the one whose `path`
 * is the longest directory-prefix of `cwd`, else `undefined`. Paths are compared
 * after normalization with `node:path.resolve`.
 */
export function resolveProjectDefault(
  defaults: readonly CaamProjectDefault[],
  cwd: string,
  tool: string,
): string | undefined {
  const normalizedCwd = NodePath.resolve(cwd);
  let best: CaamProjectDefault | undefined;
  for (const candidate of defaults) {
    if (candidate.tool !== tool) {
      continue;
    }
    const candidatePath = NodePath.resolve(candidate.path);
    if (!isDirectoryPrefix(candidatePath, normalizedCwd)) {
      continue;
    }
    if (best === undefined || NodePath.resolve(best.path).length < candidatePath.length) {
      best = candidate;
    }
  }
  return best?.profile;
}
