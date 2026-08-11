// @effect-diagnostics nodeBuiltinImport:off
/**
 * Integration test for {@link ClaudeSessionImportService}.
 *
 * Drives a synthetic Claude transcript through the real orchestration engine,
 * projection pipeline, and provider-session directory (over an in-memory,
 * fully-migrated SQLite database) and asserts both halves of an import: the
 * visible thread + message/activity history (Half A) and the resume binding
 * (Half B). Also covers idempotency (re-import is a no-op) and the no-project
 * skip.
 *
 * @module ClaudeSessionImportService.test
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import {
  ClaudeSessionImportService,
  layer as ClaudeSessionImportServiceLayer,
} from "./ClaudeSessionImportService.ts";

/* -------------------------------------------------------------------------- */
/* Test layer graph                                                           */
/* -------------------------------------------------------------------------- */

// Built bottom-up with `provideMerge` so each level exposes both its own
// services and everything beneath it; sibling layers inside a `mergeAll` never
// depend on one another (that keeps `Layer.mergeAll` parallel-safe).
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-claude-import-test-",
});

const InfraLayer = ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer));

const SqlLayer = SqlitePersistenceMemory.pipe(Layer.provideMerge(InfraLayer));

const RepositoryLayer = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
  ProviderSessionRuntime.layer,
  ThreadBackgroundLiveness.layer,
  ThreadPlanProgress.layer,
  RepositoryIdentityResolver.layer,
).pipe(Layer.provideMerge(SqlLayer));

const ReadModelLayer = Layer.mergeAll(
  OrchestrationProjectionPipelineLive,
  OrchestrationProjectionSnapshotQueryLive,
  ProviderSessionDirectoryLive,
).pipe(Layer.provideMerge(RepositoryLayer));

const OrchestrationTestLayer = OrchestrationEngineLive.pipe(Layer.provideMerge(ReadModelLayer));

const TestLayer = ClaudeSessionImportServiceLayer.pipe(Layer.provideMerge(OrchestrationTestLayer));

/* -------------------------------------------------------------------------- */
/* Synthetic transcript fixture                                               */
/* -------------------------------------------------------------------------- */

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

const ts = (second: number) => `2026-08-11T00:00:0${second}.000Z`;

/** Builds a two-turn transcript (with a tool call) whose cwd is `workspaceRoot`. */
function transcriptRecords(
  workspaceRoot: string,
  sessionId: string,
): readonly Record<string, unknown>[] {
  return [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId,
      cwd: workspaceRoot,
      gitBranch: "main",
      timestamp: ts(0),
      message: { role: "user", content: "Hello, please help me." },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId,
      cwd: workspaceRoot,
      timestamp: ts(1),
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Sure, happy to help." }],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "a1",
      sessionId,
      cwd: workspaceRoot,
      timestamp: ts(2),
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls -la" } }],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a2",
      sessionId,
      cwd: workspaceRoot,
      timestamp: ts(3),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "total 0\nfile.txt" }],
      },
      toolUseResult: { stdout: "total 0\nfile.txt" },
    },
    {
      type: "assistant",
      uuid: "a3",
      parentUuid: "u2",
      sessionId,
      cwd: workspaceRoot,
      timestamp: ts(4),
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "I listed the files." }],
      },
    },
    {
      type: "user",
      uuid: "u3",
      parentUuid: "a3",
      sessionId,
      cwd: workspaceRoot,
      timestamp: ts(5),
      message: { role: "user", content: "Second question here." },
    },
    {
      type: "assistant",
      uuid: "a4",
      parentUuid: "u3",
      sessionId,
      cwd: workspaceRoot,
      timestamp: ts(6),
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "Answer to the second." }],
      },
    },
  ];
}

const toJsonl = (records: readonly Record<string, unknown>[]): string =>
  records.map((record) => JSON.stringify(record)).join("\n");

const writeTranscript = (records: readonly Record<string, unknown>[], sessionId: string) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-import-")),
    );
    const filePath = NodePath.join(dir, `${sessionId}.jsonl`);
    yield* Effect.promise(() => NodeFSP.writeFile(filePath, toJsonl(records), "utf8"));
    return { dir, filePath };
  });

const createProject = (workspaceRoot: string, suffix: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`test:project-create:${suffix}`),
      projectId: ProjectId.make(`project-${suffix}`),
      title: "Import Test Project",
      workspaceRoot,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-5",
      },
      createdAt: ts(0),
    });
  });

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("ClaudeSessionImportService", () => {
  it.layer(TestLayer)("importTranscriptFile", (it) => {
    it.effect(
      "imports a transcript into a thread with history and a resume binding, idempotently",
      () =>
        Effect.gen(function* () {
          const importer = yield* ClaudeSessionImportService;
          const snapshotQuery = yield* ProjectionSnapshotQuery;
          const directory = yield* ProviderSessionDirectory;

          const { dir, filePath } = yield* writeTranscript(
            transcriptRecords("", SESSION_ID),
            SESSION_ID,
          );
          // The transcript's cwd must equal the project workspace root; use the
          // temp dir itself so the exact-match association succeeds.
          yield* Effect.promise(() =>
            NodeFSP.writeFile(filePath, toJsonl(transcriptRecords(dir, SESSION_ID)), "utf8"),
          );
          yield* createProject(dir, "main");

          // 3. Import.
          const outcome = yield* importer.importTranscriptFile(filePath);
          assert.equal(outcome._tag, "imported");

          const threadId = ThreadId.make(`thread:${SESSION_ID}`);
          if (outcome._tag === "imported") {
            assert.equal(outcome.threadId, threadId);
          }

          // 4. Thread + messages + activities materialised.
          const detail = yield* snapshotQuery.getThreadDetailById(threadId);
          assert.isTrue(Option.isSome(detail));
          const thread = Option.getOrThrow(detail);

          const userTexts = thread.messages
            .filter((message) => message.role === "user")
            .map((message) => message.text);
          assert.include(userTexts, "Hello, please help me.");
          assert.include(userTexts, "Second question here.");

          const assistantTexts = thread.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.text);
          assert.isTrue(
            assistantTexts.some((text) => text.includes("Sure, happy to help.")),
            "expected the first assistant reply",
          );
          assert.isTrue(
            assistantTexts.some((text) => text.includes("Answer to the second.")),
            "expected the second assistant reply",
          );

          const activityKinds = thread.activities.map((activity) => activity.kind);
          assert.include(activityKinds, "tool.started");
          assert.include(activityKinds, "tool.completed");

          // 5. Half B — resume binding.
          const binding = yield* directory.getBinding(threadId);
          assert.isTrue(Option.isSome(binding));
          const value = Option.getOrThrow(binding);
          assert.equal(value.status, "stopped");
          const cursor = asRecord(value.resumeCursor);
          assert.equal(cursor["resume"], SESSION_ID);
          const payload = asRecord(value.runtimePayload);
          assert.equal(payload["cwd"], dir);

          // 6. Idempotency — re-import is a no-op; no second thread or message.
          const messageCountBefore = thread.messages.length;
          const secondOutcome = yield* importer.importTranscriptFile(filePath);
          assert.equal(secondOutcome._tag, "skipped");

          const detailAfter = yield* snapshotQuery.getThreadDetailById(threadId);
          assert.isTrue(Option.isSome(detailAfter));
          assert.equal(Option.getOrThrow(detailAfter).messages.length, messageCountBefore);
        }),
    );

    it.effect("skips a transcript whose cwd has no matching project", () =>
      Effect.gen(function* () {
        const importer = yield* ClaudeSessionImportService;

        const noProjectSessionId = "99999999-8888-4777-8666-555555555555";
        const { dir, filePath } = yield* writeTranscript(
          transcriptRecords("", noProjectSessionId),
          noProjectSessionId,
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(filePath, toJsonl(transcriptRecords(dir, noProjectSessionId)), "utf8"),
        );

        const outcome = yield* importer.importTranscriptFile(filePath);
        assert.equal(outcome._tag, "skipped");
        if (outcome._tag === "skipped") {
          assert.equal(outcome.reason, "no-project");
        }
      }),
    );
  });
});
