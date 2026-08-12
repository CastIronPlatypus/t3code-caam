/**
 * CaamService — server-side foundation for the external `caam` CLI.
 *
 * `caam` manages provider accounts ("profiles"). T3 shells out to the installed
 * binary (name overridable via `T3CODE_CAAM_BIN`) across three stable surfaces:
 *
 * - `caam --version` to detect presence.
 * - `caam ls <tool> --json` to enumerate profiles for a tool.
 * - `caam env <tool> <profile>` to resolve the environment for a session.
 *
 * Every caam invocation degrades gracefully: a missing binary, non-zero exit, or
 * unparseable output never becomes a defect — it yields an empty/absent result.
 * Reads are TTL-cached so repeat client connects do not re-shell for every call.
 *
 * This module reads its own configuration via Effect `Config` and does not touch
 * the global `ServerConfig` service.
 *
 * @module caam/CaamService
 */
import {
  CaamProfile,
  CaamProfilesSnapshot,
  CaamToolName,
  type CaamProjectDefault,
  type CaamToolProfiles,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { parseProjectDefaults, resolveProjectDefault } from "./ProjectDefaults.ts";

// ==============================
// Constants & configuration
// ==============================

/** The two caam tools T3 integrates with. */
const SUPPORTED_TOOLS = ["claude", "codex"] as const;

const CAAM_TIMEOUT = Duration.seconds(10);
const CAAM_OUTPUT_MAX_BYTES = 64_000;
const AVAILABLE_TTL = Duration.seconds(60);
const LIST_TTL = Duration.seconds(10);
const ENV_TTL = Duration.seconds(30);

const CaamBinConfig = Config.string("T3CODE_CAAM_BIN").pipe(Config.withDefault("caam"));
const CaamDefaultsConfig = Config.string("T3CODE_CAAM_PROFILE_DEFAULTS").pipe(Config.option);
const CaamSingleDefaultConfig = Config.string("T3CODE_CAAM_PROFILE_DEFAULT").pipe(Config.option);

// ==============================
// Pure parsers (exported for tests)
// ==============================

const CaamLsProfileRaw = Schema.Struct({
  tool: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  active: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Boolean),
});

const CaamLsResponseRaw = Schema.Struct({
  profiles: Schema.optional(Schema.Array(CaamLsProfileRaw)),
});

const decodeCaamLsResponse = Schema.decodeUnknownOption(CaamLsResponseRaw);
const decodeCaamProfile = Schema.decodeUnknownOption(CaamProfile);

const CAAM_ENV_LINE_PATTERN = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Parse `caam ls <tool> --json` stdout into profiles. Returns `[]` on any parse
 * failure. `tool` supplies the fallback tool name for entries that omit it.
 */
export function parseCaamLsOutput(stdout: string, tool: string): ReadonlyArray<CaamProfile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const decoded = decodeCaamLsResponse(parsed);
  if (Option.isNone(decoded)) {
    return [];
  }
  const profiles: CaamProfile[] = [];
  for (const entry of decoded.value.profiles ?? []) {
    const profile = decodeCaamProfile({
      tool: entry.tool ?? tool,
      name: entry.name,
      active: entry.active,
      system: entry.system,
    });
    if (Option.isSome(profile)) {
      profiles.push(profile.value);
    }
  }
  return profiles;
}

/**
 * Unescape a Go `%q` double-quoted token: strip the surrounding double quotes
 * and unescape `\"`, `\\`, `\n`, `\t`. Unquoted input is returned trimmed.
 */
function goUnquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\(.)/g, (_match, char: string) => {
      switch (char) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case '"':
          return '"';
        case "\\":
          return "\\";
        default:
          return char;
      }
    });
  }
  return trimmed;
}

/**
 * Parse `caam env <tool> <profile>` stdout into an environment map. Returns `{}`
 * when the command failed (`exitCode !== 0`) or when caam printed a leading
 * `false` token to stdout. Each `export KEY="VALUE"` line becomes one entry;
 * comment (`# …`) and blank lines are ignored.
 */
export function parseCaamEnvOutput(stdout: string, exitCode: number): Record<string, string> {
  if (exitCode !== 0) {
    return {};
  }
  if (/^\s*false\b/.test(stdout)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const match = CAAM_ENV_LINE_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) {
      result[key] = goUnquote(value);
    }
  }
  return result;
}

/**
 * Map a T3 provider driver kind onto its caam tool name, or `undefined` when the
 * driver has no caam integration.
 */
export function caamToolForDriverKind(driverKind: string): string | undefined {
  switch (driverKind) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    default:
      return undefined;
  }
}

// ==============================
// Service definition
// ==============================

export interface CaamServiceShape {
  /** True if the caam binary responds to --version. Cached. */
  readonly available: Effect.Effect<boolean>;
  /** Profiles for a tool via `caam ls <tool> --json`. [] on any failure. TTL-cached (~10s). */
  readonly listProfiles: (tool: string) => Effect.Effect<ReadonlyArray<CaamProfile>>;
  /** Env map from `caam env <tool> <profile>`. {} on any failure. TTL-cached (~30s). */
  readonly resolveEnvironment: (
    tool: string,
    profile: string,
  ) => Effect.Effect<Record<string, string>>;
  /** The parsed per-project defaults (from T3CODE_CAAM_PROFILE_DEFAULTS). */
  readonly projectDefaults: Effect.Effect<ReadonlyArray<CaamProjectDefault>>;
  /** Longest path-prefix match of cwd among defaults for the given tool, else undefined. */
  readonly resolveProjectDefault: (cwd: string, tool: string) => Effect.Effect<string | undefined>;
  /** Full snapshot for the client-facing server config. */
  readonly buildSnapshot: Effect.Effect<CaamProfilesSnapshot>;
}

export class CaamService extends Context.Service<CaamService, CaamServiceShape>()(
  "t3/caam/CaamService",
) {}

// ==============================
// Implementation
// ==============================

interface CaamCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface TtlCacheEntry<A> {
  readonly value: A;
  readonly expiresAtMillis: number;
}

/**
 * A tiny per-key TTL cache mirroring the memoization approach in
 * `externalLauncher` (monotonic-clock expiry, store-on-success). On a hit within
 * the window the cached value is returned; otherwise `compute` runs and its
 * result is memoized. Errors are never cached — `compute` here always succeeds
 * with a degraded value.
 */
function makeTtlCache<A>(ttl: Duration.Duration) {
  const store = new Map<string, TtlCacheEntry<A>>();
  const ttlMillis = Duration.toMillis(ttl);
  return (key: string, compute: Effect.Effect<A>): Effect.Effect<A> =>
    Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      const entry = store.get(key);
      if (entry !== undefined && entry.expiresAtMillis > nowMillis) {
        return entry.value;
      }
      const value = yield* compute;
      store.set(key, { value, expiresAtMillis: nowMillis + ttlMillis });
      return value;
    });
}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bin = yield* CaamBinConfig;
  const defaultsRaw = yield* CaamDefaultsConfig;
  const singleDefault = yield* CaamSingleDefaultConfig;

  const rawDefaults = Option.getOrUndefined(defaultsRaw);
  const parsedDefaults = parseProjectDefaults(rawDefaults, Option.getOrUndefined(singleDefault));
  if (
    rawDefaults !== undefined &&
    rawDefaults.trim().length > 0 &&
    parseProjectDefaults(rawDefaults, undefined).length === 0
  ) {
    yield* Effect.logWarning(
      "T3CODE_CAAM_PROFILE_DEFAULTS did not yield any usable project defaults; expected a JSON array of {path, profile, tool?}.",
    );
  }

  // Run a caam subcommand, returning `undefined` on timeout or any failure so a
  // caam problem never surfaces as a defect to callers.
  const runCaam = (args: ReadonlyArray<string>): Effect.Effect<CaamCommandResult | undefined> =>
    Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(bin, args);
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, { shell: resolved.shell }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: CAAM_OUTPUT_MAX_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: CAAM_OUTPUT_MAX_BYTES }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode: Number(exitCode),
      } satisfies CaamCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(CAAM_TIMEOUT),
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed<CaamCommandResult | undefined>(undefined)),
    );

  const available = yield* Effect.cachedWithTTL(
    runCaam(["--version"]).pipe(
      Effect.map((result) => result !== undefined && result.exitCode === 0),
    ),
    AVAILABLE_TTL,
  );

  const listCache = makeTtlCache<ReadonlyArray<CaamProfile>>(LIST_TTL);
  const listProfiles = (tool: string): Effect.Effect<ReadonlyArray<CaamProfile>> =>
    listCache(
      tool,
      runCaam(["ls", tool, "--json"]).pipe(
        Effect.map((result) =>
          result === undefined || result.exitCode !== 0
            ? []
            : parseCaamLsOutput(result.stdout, tool),
        ),
      ),
    );

  const envCache = makeTtlCache<Record<string, string>>(ENV_TTL);
  const resolveEnvironment = (
    tool: string,
    profile: string,
  ): Effect.Effect<Record<string, string>> =>
    envCache(
      `${tool} ${profile}`,
      runCaam(["env", tool, profile]).pipe(
        Effect.map((result) =>
          result === undefined ? {} : parseCaamEnvOutput(result.stdout, result.exitCode),
        ),
      ),
    );

  const buildSnapshot = Effect.gen(function* () {
    const isAvailable = yield* available;
    if (!isAvailable) {
      return {
        available: false,
        tools: [],
        projectDefaults: parsedDefaults,
      } satisfies CaamProfilesSnapshot;
    }
    const tools: CaamToolProfiles[] = yield* Effect.forEach(SUPPORTED_TOOLS, (tool) =>
      listProfiles(tool).pipe(
        Effect.map((profiles) => ({ tool: CaamToolName.make(tool), profiles })),
      ),
    );
    const hasNonSystemProfile = tools.some((toolProfiles) =>
      toolProfiles.profiles.some((profile) => !profile.system),
    );
    return {
      available: hasNonSystemProfile,
      tools,
      projectDefaults: parsedDefaults,
    } satisfies CaamProfilesSnapshot;
  });

  return CaamService.of({
    available,
    listProfiles,
    resolveEnvironment,
    projectDefaults: Effect.succeed(parsedDefaults),
    resolveProjectDefault: (cwd, tool) =>
      Effect.sync(() => resolveProjectDefault(parsedDefaults, cwd, tool)),
    buildSnapshot,
  });
});

export const layer = Layer.effect(CaamService, make);

/**
 * A no-op CaamService: caam is reported absent and every read yields an
 * empty/degraded result. For tests and layers that do not want caam integration.
 */
export const layerNoop = Layer.succeed(
  CaamService,
  CaamService.of({
    available: Effect.succeed(false),
    listProfiles: () => Effect.succeed([]),
    resolveEnvironment: () => Effect.succeed({}),
    projectDefaults: Effect.succeed([]),
    resolveProjectDefault: () => Effect.succeed(undefined),
    buildSnapshot: Effect.succeed({
      available: false,
      tools: [],
      projectDefaults: [],
    }),
  }),
);
