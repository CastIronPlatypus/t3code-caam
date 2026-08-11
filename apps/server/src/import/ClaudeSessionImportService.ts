// @effect-diagnostics nodeBuiltinImport:off
/**
 * ClaudeSessionImportService - imports Claude Code CLI session transcripts into
 * first-class T3 threads.
 *
 * This service ties the pure {@link parseClaudeTranscript} parser and the pure
 * {@link buildImportPlan} translator to the live orchestration engine and the
 * provider-session runtime. It performs the two halves an imported thread needs
 * (see `.plans/09-claude-session-import.md`):
 *
 * - **Half A — visible thread + history**: create the thread via the
 *   orchestration engine, then reproduce the same domain events a live turn
 *   leaves behind (user prompts via a decider-bypass append, assistant replies
 *   via `assistant.delta`/`assistant.complete`, tool/sub-agent activities via
 *   `thread.activity.append`, session state via `thread.session.set`).
 * - **Half B — resume binding**: one `ProviderSessionDirectory.upsert` writing
 *   the `provider_session_runtime` row whose `resume_cursor.resume` is the
 *   Claude session id (= transcript filename stem), so the SDK can reattach.
 *
 * Every public method is best-effort with error channel `never`: a single
 * malformed or unreadable transcript is logged and skipped, never crashing a
 * boot scan or a project-open reactor. Imports are idempotent — thread ids are
 * deterministic (`thread:${sessionId}`) and a session whose binding already
 * exists is skipped — so overlapping triggers never duplicate a thread.
 *
 * @module ClaudeSessionImportService
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeReadline from "node:readline";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type MessageId,
  type OrchestrationEvent,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../serverSettings.ts";
import { listTranscriptFiles } from "../usage/usageTranscriptReader.ts";
import { type ClaudeTranscriptRecord, parseClaudeTranscript } from "./ClaudeTranscriptParser.ts";
import { buildImportPlan, type ImportPlan } from "./ImportTranslator.ts";
import {
  decodeImportScanCache,
  encodeImportScanCache,
  type ImportScanCache,
} from "./importScanCache.ts";

/** The Claude provider driver kind used for imports. */
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

/** Fallback model when the transcript carries no assistant model. */
const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER_KIND] ?? "claude-sonnet-5";

/**
 * The scan cache is narrowed by hand in `importScanCache`, so an opaque JSON
 * codec is enough here (the document is (de)serialised, never schema-validated).
 */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);

/** The outcome of importing a single transcript file. */
export type ImportOutcome =
  | { readonly _tag: "imported"; readonly threadId: ThreadId }
  | { readonly _tag: "skipped"; readonly reason: string };

/** Options for the internal single-file pipeline. */
interface ImportPipelineOptions {
  /**
   * When set, only import the transcript if its `cwd` exactly equals this
   * workspace root (used by {@link ClaudeSessionImportService.importForProject}).
   */
  readonly requireWorkspaceRoot?: string;
}

/* -------------------------------------------------------------------------- */
/* Raw transcript I/O (direct node fs — deliberately outside Effect)          */
/* -------------------------------------------------------------------------- */

/**
 * Streams one transcript file into its already-parsed JSON records, or `null`
 * when the file could not be read. A transient read failure is distinct from a
 * genuinely empty transcript: the caller must never cache a `null`.
 */
async function readClaudeTranscriptLines(
  filePath: string,
): Promise<ClaudeTranscriptRecord[] | null> {
  const records: ClaudeTranscriptRecord[] = [];
  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (line.length === 0) continue;
      try {
        records.push(JSON.parse(line) as ClaudeTranscriptRecord);
      } catch {
        // A single malformed line is skipped; the rest of the file still imports.
      }
    }
  } catch {
    return null;
  }
  return records;
}

/** Stats a transcript file for its cache identity, or `null` when it vanished. */
async function statTranscriptFile(
  filePath: string,
): Promise<{ readonly size: number; readonly mtimeMs: number } | null> {
  try {
    const stats = await NodeFSP.stat(filePath);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const eventStore = yield* OrchestrationEventStore;
  const pipeline = yield* OrchestrationProjectionPipeline;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;

  const scanCachePath = path.join(config.stateDir, "claude-import-cache.json");
  const fileCache: ImportScanCache = new Map();
  let cacheDirty = false;

  const nextCommandId = (tag: string) =>
    Effect.map(crypto.randomUUIDv4, (uuid) => CommandId.make(`server:import-${tag}:${uuid}`));
  const nextEventId = Effect.map(crypto.randomUUIDv4, (uuid) => EventId.make(uuid));

  /** Loads the persisted cache exactly once per process. */
  const ensureCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(scanCachePath).pipe(
        Effect.flatMap((raw) => decodeScanCacheFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      for (const [entryPath, entry] of decodeImportScanCache(document)) {
        fileCache.set(entryPath, entry);
      }
    }),
  );

  const persistCache = Effect.gen(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on the
    // next scan rather than leaving disk permanently stale.
    yield* encodeScanCacheFile(encodeImportScanCache(fileCache)).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(scanCachePath, serialized)),
      Effect.map(() => {
        cacheDirty = false;
      }),
      // A cache we cannot persist is a slower next scan, not a failed import.
      Effect.catchCause(() => Effect.void),
    );
  });

  const rememberFile = (filePath: string, size: number, mtimeMs: number) => {
    fileCache.set(filePath, { size, mtimeMs });
    cacheDirty = true;
  };

  /**
   * Persists a historical user prompt by hand-building the `thread.message-sent`
   * event and running the same append + project pair the engine worker runs
   * internally. This bypasses the decider so no `thread.turn.start` fires and no
   * provider process is spawned (see recon-orchestration §3).
   */
  const appendHistoricalUserMessage = (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly text: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const eventId = yield* nextEventId;
      const event = {
        eventId,
        aggregateKind: "thread",
        aggregateId: input.threadId,
        occurredAt: input.createdAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: input.threadId,
          messageId: input.messageId,
          role: "user",
          text: input.text,
          turnId: null,
          streaming: false,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      } satisfies Omit<OrchestrationEvent, "sequence">;
      const saved = yield* eventStore.append(event);
      yield* pipeline.projectEvent(saved);
    });

  /**
   * Executes an {@link ImportPlan} against the orchestration engine and the
   * provider-session directory. All writes run strictly sequentially so the
   * event store's global monotonic sequence follows plan order.
   */
  const executePlan = (plan: ImportPlan, projectId: ProjectId) =>
    Effect.gen(function* () {
      const threadId = plan.thread.threadId;

      // Half A: create the thread shell.
      yield* engine.dispatch({
        type: "thread.create",
        commandId: yield* nextCommandId("thread-create"),
        threadId,
        projectId,
        title: plan.thread.title,
        modelSelection: plan.thread.modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: plan.thread.gitBranch ?? null,
        worktreePath: null,
        createdAt: plan.thread.createdAt,
      });

      // Half A: replay each operation in order.
      yield* Effect.forEach(
        plan.operations,
        (op) =>
          Effect.gen(function* () {
            switch (op.op) {
              case "user-message":
                yield* appendHistoricalUserMessage({
                  threadId,
                  messageId: op.messageId,
                  text: op.text,
                  createdAt: op.createdAt,
                });
                return;
              case "session-set":
                yield* engine.dispatch({
                  type: "thread.session.set",
                  commandId: yield* nextCommandId("session-set"),
                  threadId,
                  session: op.session,
                  createdAt: op.createdAt,
                });
                return;
              case "assistant-message":
                yield* engine.dispatch({
                  type: "thread.message.assistant.delta",
                  commandId: yield* nextCommandId("assistant-delta"),
                  threadId,
                  messageId: op.messageId,
                  delta: op.text,
                  turnId: op.turnId,
                  createdAt: op.createdAt,
                });
                yield* engine.dispatch({
                  type: "thread.message.assistant.complete",
                  commandId: yield* nextCommandId("assistant-complete"),
                  threadId,
                  messageId: op.messageId,
                  turnId: op.turnId,
                  createdAt: op.createdAt,
                });
                return;
              case "activity": {
                const activityId = yield* nextEventId;
                yield* engine.dispatch({
                  type: "thread.activity.append",
                  commandId: yield* nextCommandId("activity"),
                  threadId,
                  activity: { ...op.activity, id: activityId },
                  createdAt: op.createdAt,
                });
                return;
              }
            }
          }),
        { discard: true },
      );

      // Half B: seed the resume binding. Status is "stopped" so the reaper never
      // treats an imported-but-idle session as a stale running one.
      const binding = plan.binding;
      const instanceId = ProviderInstanceId.make(binding.instanceId);
      yield* directory.upsert({
        threadId,
        provider: CLAUDE_DRIVER_KIND,
        providerInstanceId: instanceId,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        resumeCursor: {
          threadId,
          resume: binding.resume,
          ...(binding.resumeSessionAt !== undefined
            ? { resumeSessionAt: binding.resumeSessionAt }
            : {}),
          turnCount: binding.turnCount,
        },
        runtimePayload: {
          cwd: binding.cwd ?? null,
          model: binding.model,
          activeTurnId: null,
          lastError: null,
          modelSelection: { instanceId, model: binding.model },
        },
      });
    });

  /** The full single-file import pipeline. Best-effort — never throws. */
  const runImportPipeline = (
    filePath: string,
    options: ImportPipelineOptions,
  ): Effect.Effect<ImportOutcome, never> =>
    Effect.gen(function* () {
      yield* ensureCacheLoaded;

      // 2 (stat first, needed for the cache key). A vanished/unreadable file is
      // never cached, so it is re-checked next scan.
      const stat = yield* Effect.promise(() => statTranscriptFile(filePath));
      if (stat === null) return { _tag: "skipped", reason: "unreadable" } as const;

      // 1. Warm cache hit — an unchanged file already handled once.
      const cached = fileCache.get(filePath);
      if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return { _tag: "skipped", reason: "cached" } as const;
      }

      // 2. Read the raw records. A transient failure must not be cached.
      const records = yield* Effect.promise(() => readClaudeTranscriptLines(filePath));
      if (records === null) return { _tag: "skipped", reason: "unreadable" } as const;

      const sessionId = path.basename(filePath, ".jsonl");

      // 3. Binding-level dedup: skip (and cache) a session T3 already owns.
      const bindings = yield* directory.listBindings();
      const alreadyImported = bindings.some((entry) => {
        const cursor = entry.resumeCursor;
        return isRecord(cursor) && cursor["resume"] === sessionId;
      });
      if (alreadyImported) {
        rememberFile(filePath, stat.size, stat.mtimeMs);
        return { _tag: "skipped", reason: "already-imported" } as const;
      }

      // 4. Parse. A transcript with no turns or no cwd is stable-empty: cache it.
      const conversation = parseClaudeTranscript(records, { sessionId });
      if (conversation.turns.length === 0 || conversation.cwd === undefined) {
        rememberFile(filePath, stat.size, stat.mtimeMs);
        return { _tag: "skipped", reason: "empty" } as const;
      }

      // 5. Project association (exact workspace-root match). Not cached: the file
      // becomes importable once the user adds the matching project.
      if (
        options.requireWorkspaceRoot !== undefined &&
        conversation.cwd !== options.requireWorkspaceRoot
      ) {
        return { _tag: "skipped", reason: "no-project" } as const;
      }
      const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot(conversation.cwd);
      if (Option.isNone(project)) {
        return { _tag: "skipped", reason: "no-project" } as const;
      }

      // 6. Resolve model + instance, then 7. build the plan.
      const model =
        conversation.model !== undefined && conversation.model.length > 0
          ? conversation.model
          : DEFAULT_MODEL;
      const instanceId = defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND);
      const plan = buildImportPlan(conversation, { instanceId, model });

      // 8. Execute Half A + Half B.
      yield* executePlan(plan, project.value.id);

      // 9. Cache the successful import.
      rememberFile(filePath, stat.size, stat.mtimeMs);
      return { _tag: "imported", threadId: plan.thread.threadId } as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("claude import: file failed", {
            filePath,
            cause: Cause.pretty(cause),
          }),
          { _tag: "skipped", reason: "failed" } as const,
        ),
      ),
    );

  /**
   * Resolves this machine's `~/.claude/projects` transcript directory. Claude's
   * config dir is the home itself when overridden, but a default install nests
   * transcripts under `<home>/.claude/projects` — probe both.
   */
  const resolveClaudeTranscriptDir = (homePath: string) =>
    Effect.gen(function* () {
      const nested = path.join(homePath, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      return nestedExists ? nested : path.join(homePath, "projects");
    });

  const resolveTranscriptDir = Effect.gen(function* () {
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent).pipe(
      Effect.provideService(Path.Path, path),
    );
    return yield* resolveClaudeTranscriptDir(claudeHome);
  });

  /** Scans and imports every new transcript under `dir`, best-effort. */
  const scanDir = (dir: string, options: ImportPipelineOptions) =>
    Effect.gen(function* () {
      yield* ensureCacheLoaded;
      const files = yield* Effect.promise(() => listTranscriptFiles(dir, 0));
      yield* Effect.forEach(files, (file) => runImportPipeline(file.path, options), {
        discard: true,
      });
      yield* persistCache;
    });

  const runFullScan = () =>
    resolveTranscriptDir.pipe(
      Effect.flatMap((dir) => scanDir(dir, {})),
      Effect.catchCause((cause) =>
        Effect.logWarning("claude import: full scan failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const importForProject = (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) =>
    resolveTranscriptDir.pipe(
      Effect.flatMap((dir) => scanDir(dir, { requireWorkspaceRoot: input.workspaceRoot })),
      Effect.catchCause((cause) =>
        Effect.logWarning("claude import: project scan failed", {
          projectId: input.projectId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const importTranscriptFile = (filePath: string) => runImportPipeline(filePath, {});

  return { runFullScan, importForProject, importTranscriptFile } as const;
});

/** The service shape, inferred from {@link make}. */
export type ClaudeSessionImportServiceShape =
  typeof make extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

export class ClaudeSessionImportService extends Context.Service<
  ClaudeSessionImportService,
  ClaudeSessionImportServiceShape
>()("t3/import/ClaudeSessionImportService") {}

export const layer = Layer.effect(ClaudeSessionImportService, make);
