import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ClaudeSessionImportService } from "../../import/ClaudeSessionImportService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ClaudeImportReactor,
  type ClaudeImportReactorShape,
} from "../Services/ClaudeImportReactor.ts";

type ProjectCreatedEvent = Extract<OrchestrationEvent, { type: "project.created" }>;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const importer = yield* ClaudeSessionImportService;
  // `importForProject` reads settings to resolve the Claude home directory, so
  // capture the settings service once and provide it per event; this keeps the
  // reactor's `start` requirement to `Scope` only (matching the shape).
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const processProjectCreated = (event: ProjectCreatedEvent) =>
    importer
      .importForProject({
        projectId: event.payload.projectId,
        workspaceRoot: event.payload.workspaceRoot,
      })
      .pipe(
        Effect.provideService(ServerSettings.ServerSettingsService, serverSettings),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("claude import reactor failed to process event", {
            eventType: event.type,
            projectId: event.payload.projectId,
            cause: Cause.pretty(cause),
          });
        }),
      );

  const worker = yield* makeDrainableWorker(processProjectCreated);

  const start: ClaudeImportReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "project.created") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ClaudeImportReactorShape;
});

export const ClaudeImportReactorLive = Layer.effect(ClaudeImportReactor, make);
