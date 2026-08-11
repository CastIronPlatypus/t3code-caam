import { type OrchestrationEvent, ProjectId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  ClaudeSessionImportService,
  type ImportOutcome,
} from "../../import/ClaudeSessionImportService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ClaudeImportReactor } from "../Services/ClaudeImportReactor.ts";
import { ClaudeImportReactorLive } from "./ClaudeImportReactor.ts";

interface ImportCall {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

describe("ClaudeImportReactor", () => {
  it.effect("imports transcripts for a newly created project", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-claude-import-reactor-test");
      const workspaceRoot = "/tmp/claude-import-reactor-test";

      const recorded = yield* Ref.make<ReadonlyArray<ImportCall>>([]);
      const called = yield* Deferred.make<void>();

      // Minimal `project.created` event; the reactor only reads `type` and
      // `payload.{projectId,workspaceRoot}`, so the full envelope is unneeded.
      const event = {
        type: "project.created",
        payload: { projectId, workspaceRoot },
      } as unknown as OrchestrationEvent;

      const EngineStub = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.make(event),
        latestSequence: Effect.succeed(0),
      });

      const ImporterStub = Layer.succeed(ClaudeSessionImportService, {
        runFullScan: () => Effect.void,
        importForProject: (input: ImportCall) =>
          Ref.update(recorded, (calls) => [...calls, input]).pipe(
            Effect.andThen(Deferred.succeed(called, undefined)),
            Effect.asVoid,
          ),
        importTranscriptFile: () =>
          Effect.succeed({ _tag: "skipped", reason: "stub" } satisfies ImportOutcome),
      });

      const ReactorLayer = ClaudeImportReactorLive.pipe(
        Layer.provide(EngineStub),
        Layer.provide(ImporterStub),
        Layer.provide(ServerSettings.layerTest()),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* ClaudeImportReactor;
        yield* reactor.start();
        // Deterministic: resolves exactly when the stubbed importer is invoked.
        yield* Deferred.await(called);
      }).pipe(Effect.provide(ReactorLayer), Effect.scoped);

      const calls = yield* Ref.get(recorded);
      assert.deepStrictEqual(calls, [{ projectId, workspaceRoot }]);
    }),
  );
});
