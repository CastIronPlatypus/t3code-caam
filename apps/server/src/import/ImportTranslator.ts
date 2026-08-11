/**
 * Pure translator: one {@link ImportedConversation} → an ordered, executable
 * {@link ImportPlan}.
 *
 * The plan is a typed, deterministic description of the writes an importer
 * service must make to reproduce a Claude Code CLI session as a first-class T3
 * thread. This module does **no** I/O and has **no** Effect dependencies — it is
 * plain functions over plain data so it is trivially unit-testable. The service
 * consumes the plan and performs the actual dispatch/append against the
 * orchestration engine (see "Execution contract" below).
 *
 * ## Execution contract (what the service must honor)
 *
 * 1. Create the thread from {@link ImportPlan.thread} via `thread.create`
 *    (assigning it to the project that owns `thread.cwd`), using
 *    `thread.threadId` verbatim so re-imports are idempotent.
 * 2. Execute `operations` **strictly in order**, one at a time (await each write
 *    before the next) so the event store's global monotonic sequence matches the
 *    plan order. Each operation carries an explicit `mode`:
 *    - `mode: "bypass-append"` (only `user-message`): DO NOT dispatch a command.
 *      Hand-build a `thread.message-sent` event (role `user`, `streaming:false`)
 *      and persist it via `OrchestrationEventStore.append` +
 *      `OrchestrationProjectionPipeline.projectEvent`. This bypasses the decider
 *      so no `thread.turn.start` / live provider call is triggered.
 *    - `mode: "dispatch"` (`session-set`, `assistant-message`, `activity`):
 *      dispatch the corresponding command through `OrchestrationEngine.dispatch`
 *      (see per-op notes on {@link ImportPlanOperation}).
 *    The service mints the random `commandId` / `eventId` (and, for activities,
 *    the fresh `EventId` `id`) at execution time; the translator never does.
 * 3. After all operations, write Half B — the resume binding — from
 *    {@link ImportPlan.binding}.
 *
 * ## Per-turn operation order (as emitted)
 *
 * For each turn, in order: `session-set`(running, activeTurnId=turnId) →
 * `user-message` → `assistant-message` (skipped when the assistant text is empty)
 * → activities. Activities per turn: for each main-conversation tool call,
 * `tool.started` then `tool.completed` (the latter only when a result was
 * captured); then for each sub-agent, `task.started` → the sub-agent's tool
 * activities (tagged `agentId` + `parentToolUseId`) → `task.completed`. The whole
 * plan ends with one `session-set`(status `stopped`, activeTurnId `null`).
 *
 * ## Activity payload construction
 *
 * Activities are built **directly** as {@link OrchestrationThreadActivity} values
 * (minus `id`, which the service assigns), rather than by synthesizing
 * `ProviderRuntimeEvent`s and calling `runtimeEventToActivities`. Rationale: the
 * translator must stay pure and id-free, but `runtimeEventToActivities` stamps
 * `activity.id = event.eventId` and requires a fully-formed
 * `ProviderRuntimeEvent` (a large discriminated union with lifecycle-guarded
 * `itemType`s, request ids, etc.). Constructing the four activity shapes we
 * actually emit (`tool.started`, `tool.completed`, `task.started`,
 * `task.completed`) by hand — matching the canonical `kind`/`tone`/`summary`/
 * `payload` shapes documented in `ProviderRuntimeIngestion.runtimeEventToActivities`
 * — is lighter and lets the translator control `itemType`/`detail`/`data`/
 * `agentId`/`parentToolUseId` without inventing ids. The results satisfy the real
 * `OrchestrationThreadActivity` schema.
 *
 * @module ImportTranslator
 */

import {
  type ModelSelection,
  MessageId,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import type {
  ImportedConversation,
  ImportedSubAgent,
  ImportedToolCall,
} from "./ClaudeTranscriptParser.ts";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Fallback thread title when the conversation has no usable first prompt. */
export const DEFAULT_IMPORT_TITLE = "Imported Claude session";

/** Max characters for a derived thread title before it is truncated. */
const TITLE_MAX_CHARS = 80;

/** Max characters for an activity `detail`/`summary` string before truncation. */
const DETAIL_MAX_CHARS = 2000;

/**
 * Deterministic fallback timestamp. Real transcripts always carry timestamps;
 * this only guards conversations whose records had none, so the typed
 * `IsoDateTime` fields stay populated without the translator reading a clock.
 */
const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* Plan model (exported)                                                      */
/* -------------------------------------------------------------------------- */

/** An {@link OrchestrationThreadActivity} minus its `id` — the service fills it. */
export type ImportActivity = Omit<OrchestrationThreadActivity, "id">;

/** Thread-creation inputs for `thread.create`. */
export interface ImportPlanThread {
  /** Deterministic, derived from the session id so re-imports are idempotent. */
  readonly threadId: ThreadId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly cwd: string | undefined;
  readonly gitBranch: string | undefined;
  readonly runtimeMode: "full-access";
  /** The conversation's start timestamp (falls back when the records had none). */
  readonly createdAt: string;
}

/**
 * A historical user prompt. Executed via the DECIDER-BYPASS append path
 * (`OrchestrationEventStore.append` + `ProjectionPipeline.projectEvent`) so no
 * turn is started and no provider process spawns.
 */
export interface ImportUserMessageOp {
  readonly op: "user-message";
  readonly mode: "bypass-append";
  readonly messageId: MessageId;
  readonly text: string;
  readonly createdAt: string;
}

/** Sets session/turn state. Dispatched via `thread.session.set`. */
export interface ImportSessionSetOp {
  readonly op: "session-set";
  readonly mode: "dispatch";
  readonly session: OrchestrationSession;
  readonly createdAt: string;
}

/**
 * An assistant reply. The service turns this into a
 * `thread.message.assistant.delta` (full text) followed by a
 * `thread.message.assistant.complete`, both with `messageId`. Never emitted for
 * an empty assistant text.
 */
export interface ImportAssistantMessageOp {
  readonly op: "assistant-message";
  readonly mode: "dispatch";
  readonly messageId: MessageId;
  readonly turnId: TurnId;
  readonly text: string;
  readonly createdAt: string;
}

/**
 * A tool/sub-agent activity. Dispatched via `thread.activity.append`; the
 * service assigns the activity's fresh `EventId` `id`.
 */
export interface ImportActivityOp {
  readonly op: "activity";
  readonly mode: "dispatch";
  readonly activity: ImportActivity;
  readonly createdAt: string;
}

/** The ordered, discriminated union of import operations. */
export type ImportPlanOperation =
  | ImportUserMessageOp
  | ImportSessionSetOp
  | ImportAssistantMessageOp
  | ImportActivityOp;

/** Half B — the resume binding descriptor (a direct `provider_session_runtime` upsert). */
export interface ImportPlanBinding {
  readonly sessionId: string;
  readonly resume: string;
  readonly resumeSessionAt: string | undefined;
  readonly turnCount: number;
  readonly cwd: string | undefined;
  readonly model: string;
  readonly instanceId: string;
}

/** The complete, ordered, executable import plan for one transcript. */
export interface ImportPlan {
  readonly sessionId: string;
  readonly thread: ImportPlanThread;
  readonly operations: readonly ImportPlanOperation[];
  readonly binding: ImportPlanBinding;
}

/** Inputs the service resolves before translating (model + provider instance). */
export interface BuildImportPlanOptions {
  /** The resolved provider instance id (e.g. `"claudeAgent"`). */
  readonly instanceId: string;
  /**
   * The resolved model: the transcript's model when present, else the provider
   * instance's default. Must be non-empty.
   */
  readonly model: string;
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Derives a single-line, truncated thread title from the first user prompt. */
function deriveTitle(conversation: ImportedConversation): string {
  for (const turn of conversation.turns) {
    const text = turn.userMessage.text.trim();
    if (text.length > 0) {
      const oneLine = text.replace(/\s+/g, " ").trim();
      return truncate(oneLine, TITLE_MAX_CHARS);
    }
  }
  return DEFAULT_IMPORT_TITLE;
}

/**
 * Picks a readable `detail` string from a tool call's input: prefers a few
 * common human-facing fields, else a compact JSON encoding. Deterministic.
 */
function detailFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["command", "description", "prompt", "file_path", "path", "pattern", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return truncate(value, DETAIL_MAX_CHARS);
    }
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return undefined;
  return truncate(JSON.stringify(input), DETAIL_MAX_CHARS);
}

/* -------------------------------------------------------------------------- */
/* Activity builders (path (b): construct OrchestrationThreadActivity directly)*/
/* -------------------------------------------------------------------------- */

function toolStartedActivity(
  call: ImportedToolCall,
  turnId: TurnId,
  createdAt: string,
): ImportActivity {
  const detail = detailFromInput(call.input);
  return {
    tone: "tool",
    kind: "tool.started",
    summary: `${call.toolName} started`,
    payload: {
      itemType: call.toolName,
      ...(detail !== undefined ? { detail } : {}),
      ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
      ...(call.parentToolUseId !== undefined ? { parentToolUseId: call.parentToolUseId } : {}),
    },
    turnId,
    createdAt,
  };
}

function toolCompletedActivity(
  call: ImportedToolCall,
  turnId: TurnId,
  createdAt: string,
): ImportActivity {
  const result = call.result;
  const detail =
    result !== undefined && result.content.length > 0
      ? truncate(result.content, DETAIL_MAX_CHARS)
      : undefined;
  return {
    tone: "tool",
    kind: "tool.completed",
    summary: call.toolName,
    payload: {
      itemType: call.toolName,
      ...(detail !== undefined ? { detail } : {}),
      ...(result?.isError === true ? { data: { isError: true } } : {}),
      ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
      ...(call.parentToolUseId !== undefined ? { parentToolUseId: call.parentToolUseId } : {}),
    },
    turnId,
    createdAt,
  };
}

function taskStartedActivity(
  agent: ImportedSubAgent,
  taskId: string,
  turnId: TurnId,
  createdAt: string,
): ImportActivity {
  const detail =
    agent.description !== undefined && agent.description.length > 0
      ? truncate(agent.description, DETAIL_MAX_CHARS)
      : undefined;
  return {
    tone: "info",
    kind: "task.started",
    summary: "Task started",
    payload: {
      taskId,
      ...(detail !== undefined ? { detail } : {}),
      ...(agent.agentId !== undefined ? { agentId: agent.agentId } : {}),
    },
    turnId,
    createdAt,
  };
}

function taskCompletedActivity(
  agent: ImportedSubAgent,
  taskId: string,
  turnId: TurnId,
  createdAt: string,
): ImportActivity {
  const status = agent.status ?? "completed";
  const failed = status === "failed";
  const summaryText =
    agent.resultSummary !== undefined && agent.resultSummary.length > 0
      ? truncate(agent.resultSummary, DETAIL_MAX_CHARS)
      : undefined;
  return {
    tone: failed ? "error" : "info",
    kind: "task.completed",
    summary: failed ? "Task failed" : "Task completed",
    payload: {
      taskId,
      status,
      ...(summaryText !== undefined ? { summary: summaryText, detail: summaryText } : {}),
      ...(agent.agentId !== undefined ? { agentId: agent.agentId } : {}),
    },
    turnId,
    createdAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Translator                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Translates one parsed conversation into an ordered {@link ImportPlan}.
 *
 * Pure and deterministic: given the same conversation and options it always
 * produces the same plan (deterministic, namespaced ids; no clock, no I/O).
 */
export function buildImportPlan(
  conversation: ImportedConversation,
  options: BuildImportPlanOptions,
): ImportPlan {
  const { sessionId } = conversation;
  const baseTimestamp = conversation.startedAt ?? conversation.endedAt ?? FALLBACK_TIMESTAMP;
  const threadId = ThreadId.make(`thread:${sessionId}`);
  const instanceId = ProviderInstanceId.make(options.instanceId);

  const modelSelection: ModelSelection = {
    instanceId,
    model: options.model,
  };

  const thread: ImportPlanThread = {
    threadId,
    title: deriveTitle(conversation),
    modelSelection,
    cwd: conversation.cwd,
    gitBranch: conversation.gitBranch,
    runtimeMode: "full-access",
    createdAt: conversation.startedAt ?? baseTimestamp,
  };

  const operations: ImportPlanOperation[] = [];

  const sessionAt = (
    status: OrchestrationSession["status"],
    activeTurnId: TurnId | null,
    createdAt: string,
  ): OrchestrationSession => ({
    threadId,
    status,
    providerName: null,
    providerInstanceId: instanceId,
    runtimeMode: "full-access",
    activeTurnId,
    lastError: null,
    updatedAt: createdAt,
  });

  conversation.turns.forEach((turn, turnIndex) => {
    const turnId = TurnId.make(`turn:${sessionId}:${turnIndex}`);
    const turnAt = turn.userMessage.timestamp ?? baseTimestamp;

    // 1. Session goes running for this turn.
    operations.push({
      op: "session-set",
      mode: "dispatch",
      session: sessionAt("running", turnId, turnAt),
      createdAt: turnAt,
    });

    // 2. The user prompt (decider-bypass append).
    operations.push({
      op: "user-message",
      mode: "bypass-append",
      messageId: MessageId.make(`msg:${sessionId}:${turnIndex}:user`),
      text: turn.userMessage.text,
      createdAt: turnAt,
    });

    // 3. The assistant reply — skipped entirely when there is no text.
    if (turn.assistantText.length > 0) {
      operations.push({
        op: "assistant-message",
        mode: "dispatch",
        messageId: MessageId.make(`msg:${sessionId}:${turnIndex}:assistant`),
        turnId,
        text: turn.assistantText,
        createdAt: turnAt,
      });
    }

    // 4a. Main-conversation tool calls, in order: started then completed.
    for (const call of turn.toolCalls) {
      operations.push({
        op: "activity",
        mode: "dispatch",
        activity: toolStartedActivity(call, turnId, turnAt),
        createdAt: turnAt,
      });
      if (call.result !== undefined) {
        operations.push({
          op: "activity",
          mode: "dispatch",
          activity: toolCompletedActivity(call, turnId, turnAt),
          createdAt: turnAt,
        });
      }
    }

    // 4b. Sub-agents: task.started → nested tool activities → task.completed.
    turn.subAgents.forEach((agent, subIndex) => {
      const taskId = agent.taskId ?? agent.agentId ?? `task:${sessionId}:${turnIndex}:${subIndex}`;

      operations.push({
        op: "activity",
        mode: "dispatch",
        activity: taskStartedActivity(agent, taskId, turnId, turnAt),
        createdAt: turnAt,
      });

      for (const call of agent.toolCalls) {
        operations.push({
          op: "activity",
          mode: "dispatch",
          activity: toolStartedActivity(call, turnId, turnAt),
          createdAt: turnAt,
        });
        if (call.result !== undefined) {
          operations.push({
            op: "activity",
            mode: "dispatch",
            activity: toolCompletedActivity(call, turnId, turnAt),
            createdAt: turnAt,
          });
        }
      }

      operations.push({
        op: "activity",
        mode: "dispatch",
        activity: taskCompletedActivity(agent, taskId, turnId, turnAt),
        createdAt: turnAt,
      });
    });
  });

  // Final: session goes stopped for the whole plan.
  const endTimestamp = conversation.endedAt ?? baseTimestamp;
  operations.push({
    op: "session-set",
    mode: "dispatch",
    session: sessionAt("stopped", null, endTimestamp),
    createdAt: endTimestamp,
  });

  const binding: ImportPlanBinding = {
    sessionId,
    resume: sessionId,
    resumeSessionAt: conversation.lastAssistantUuid,
    turnCount: conversation.turns.length,
    cwd: conversation.cwd,
    model: options.model,
    instanceId: options.instanceId,
  };

  return { sessionId, thread, operations, binding };
}
