/**
 * ClaudeImportReactor - Claude session import reactor service interface.
 *
 * Owns a background worker that reacts to `project.created` domain events and
 * performs best-effort import of any Claude CLI transcripts whose workspace
 * root matches the newly created project.
 *
 * @module ClaudeImportReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ClaudeImportReactorShape - Service API for the Claude import reactor.
 */
export interface ClaudeImportReactorShape {
  /**
   * Start reacting to `project.created` orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ClaudeImportReactor - Service tag for Claude session import workers.
 */
export class ClaudeImportReactor extends Context.Service<
  ClaudeImportReactor,
  ClaudeImportReactorShape
>()("t3/orchestration/Services/ClaudeImportReactor") {}
