/**
 * Pure parser for Claude Code CLI `.jsonl` session transcripts.
 *
 * Turns the already-parsed JSON records of one transcript file into a structured
 * {@link ImportedConversation} that the import translator can fold into T3
 * orchestration events. This module does **no** file I/O and has **no** Effect
 * dependencies — it is plain functions over plain data so it is trivially
 * unit-testable. The importer service performs the reads and hands the records
 * (and the session id, which is the transcript's filename stem) to
 * {@link parseClaudeTranscript}.
 *
 * ## Transcript shape (verified against real transcripts on disk)
 *
 * Each file is a DAG of records linked by `uuid` → `parentUuid`, written in
 * chronological (file) order. We walk in that file order and rely on it for
 * turn sequencing, keeping `parentUuid` for sidechain nesting.
 *
 * - `user` records come in three flavors: real prompts (`message.content` is a
 *   string, or an array of blocks whose text we join), tool-result carriers
 *   (`message.content` is an array holding a `tool_result` block, often with a
 *   sibling `toolUseResult` field), and meta records (`isMeta:true`, e.g.
 *   slash-command stdout) which we skip entirely — they are never turn
 *   boundaries.
 * - `assistant` records are streaming-split: **one content block each**
 *   (`thinking`, `text`, or `tool_use`), chained by `parentUuid`. One logical
 *   assistant turn spans several records. `thinking` blocks are dropped (not
 *   durable). `message.model` names the model.
 * - `isSidechain:true` marks Task sub-agent transcripts, interleaved in the same
 *   file. We group them into {@link ImportedSubAgent}s (see "Assumptions").
 * - Bookkeeping types (`mode`, `permission-mode`, `file-history-delta`,
 *   `file-history-snapshot`, `last-prompt`, `queue-operation`, `attachment`,
 *   `system`, `ai-title`, …) are ignored.
 *
 * ## Assumptions / best-effort decisions
 *
 * - **Turn** = one real user prompt plus everything that follows up to the next
 *   real user prompt (assistant text, tool calls, sub-agents).
 * - Assistant / tool content that appears before the first real user prompt (a
 *   resumed transcript can open mid-conversation) is attached to a leading turn
 *   whose `userMessage.text` is empty, so no content is silently dropped.
 * - **Sub-agent grouping**: sidechain records form their own `uuid`/`parentUuid`
 *   chains. The first sidechain record of a chain (its `parentUuid` is not itself
 *   a sidechain record we have seen) roots a new sub-agent; its `uuid` becomes
 *   the `agentId`. Descendants inherit that `agentId` via `parentUuid`. The
 *   rooting sidechain user prompt's text becomes the agent `description`.
 * - **Sub-agent ↔ Task linkage**: when a sub-agent's `description` matches the
 *   `description`/`prompt` input of a `Task` tool call in the enclosing turn, we
 *   set the sub-agent's `taskId` to that Task's `toolUseId` and tag the
 *   sub-agent's tool calls with `parentToolUseId = taskId` so the translator can
 *   nest them. When no match is found these stay `undefined`.
 * - **Tool result matching** is by `tool_use_id`, globally within the file
 *   (ids are unique), so a result carried by a later record is stitched onto the
 *   original `tool_use` regardless of turn/sub-agent boundaries.
 *
 * Malformed records are skipped, never thrown on.
 *
 * @module ClaudeTranscriptParser
 */

/* -------------------------------------------------------------------------- */
/* Input record type (permissive)                                             */
/* -------------------------------------------------------------------------- */

/**
 * A permissive view of one already-parsed transcript record. Every field is
 * optional because transcripts mix many record shapes and evolve over time; the
 * parser guards each access and skips anything it does not understand.
 */
export interface ClaudeTranscriptRecord {
  readonly type?: string;
  readonly uuid?: string;
  readonly parentUuid?: string | null;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly timestamp?: string;
  readonly message?: unknown;
  readonly isSidechain?: boolean;
  readonly isMeta?: boolean;
  readonly toolUseResult?: unknown;
  readonly [key: string]: unknown;
}

/** Options for {@link parseClaudeTranscript}. */
export interface ParseClaudeTranscriptOptions {
  /** The session id — the transcript filename stem. Used as the resume key. */
  readonly sessionId: string;
}

/* -------------------------------------------------------------------------- */
/* Output model                                                               */
/* -------------------------------------------------------------------------- */

/** A single tool invocation and (once matched) its result. */
export interface ImportedToolCall {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  /** The tool result, present once a matching `tool_result` carrier is found. */
  result?: { readonly content: string; readonly isError?: boolean };
  /** Set for tool calls that ran inside a sub-agent. */
  readonly agentId?: string;
  /** The spawning `Task` tool's id, when it could be linked. */
  readonly parentToolUseId?: string;
}

/** A Task sub-agent's grouped sidechain activity. */
export interface ImportedSubAgent {
  /** Derived from the rooting sidechain record's `uuid`. */
  readonly agentId?: string;
  /** The spawning `Task` tool's `toolUseId`, when it could be linked. */
  readonly taskId?: string;
  /** The sub-agent's task prompt / first user message, when available. */
  readonly description?: string;
  /** Tool calls made inside the sub-agent, tagged with `agentId`/`parentToolUseId`. */
  readonly toolCalls: ImportedToolCall[];
  /** Best-effort status; `"completed"` once any assistant output was seen. */
  status?: string;
  /** Concatenated assistant text the sub-agent produced (its result). */
  resultSummary?: string;
}

/** One conversational turn: a user prompt plus the assistant response to it. */
export interface ImportedTurn {
  readonly userMessage: {
    readonly text: string;
    readonly timestamp: string | undefined;
    readonly uuid: string | undefined;
  };
  /** Concatenated assistant `text` blocks (thinking excluded), in order. */
  assistantText: string;
  /** Tool calls made in the main conversation during this turn, in order. */
  readonly toolCalls: ImportedToolCall[];
  /** Sub-agents spawned during this turn. */
  readonly subAgents: ImportedSubAgent[];
}

/** The structured conversation reconstructed from one transcript file. */
export interface ImportedConversation {
  /** = the transcript filename stem passed via options. */
  readonly sessionId: string;
  /** Working directory the session ran in, read from the records. */
  readonly cwd: string | undefined;
  /** Git branch the session ran on, when present. */
  readonly gitBranch: string | undefined;
  /** Model taken from assistant records, when present. */
  readonly model: string | undefined;
  /** ISO timestamp of the earliest record. */
  readonly startedAt: string | undefined;
  /** ISO timestamp of the latest record. */
  readonly endedAt: string | undefined;
  /** `uuid` of the last (non-sidechain) assistant record — the resume cursor. */
  readonly lastAssistantUuid: string | undefined;
  readonly turns: ImportedTurn[];
}

/* -------------------------------------------------------------------------- */
/* Small guards / helpers                                                     */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Flattens a `tool_result`/`content` value into a single string. Claude writes
 * this either as a plain string or as an array of `{ type: "text", text }`
 * blocks; anything else is JSON-stringified so no information is lost.
 */
function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const block of value) {
      const record = asRecord(block);
      if (record && typeof record["text"] === "string") {
        parts.push(record["text"]);
      } else if (typeof block === "string") {
        parts.push(block);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    return parts.join("\n");
  }
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

/** Joins the text of a user `message.content` that is a string or block array. */
function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const record = asRecord(block);
      if (record && record["type"] === "text" && typeof record["text"] === "string") {
        parts.push(record["text"]);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** The single content block of an assistant record (streaming-split), if any. */
function assistantBlock(message: Record<string, unknown>): Record<string, unknown> | null {
  const content = message["content"];
  if (Array.isArray(content)) {
    for (const block of content) {
      const record = asRecord(block);
      if (record) return record;
    }
    return null;
  }
  return asRecord(content);
}

/** The `tool_result` block of a user carrier record, if this is one. */
function toolResultBlock(content: unknown): Record<string, unknown> | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const record = asRecord(block);
    if (record && record["type"] === "tool_result") return record;
  }
  return null;
}

const BOOKKEEPING_TYPES = new Set<string>([
  "mode",
  "permission-mode",
  "file-history-delta",
  "file-history-snapshot",
  "last-prompt",
  "queue-operation",
  "attachment",
  "system",
  "ai-title",
]);

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parses one Claude Code transcript into a structured {@link ImportedConversation}.
 *
 * `records` must already be JSON-parsed (the importer service reads the file);
 * they are expected in chronological file order. Unknown record types and
 * malformed records are skipped, never thrown on.
 */
export function parseClaudeTranscript(
  records: readonly ClaudeTranscriptRecord[],
  opts: ParseClaudeTranscriptOptions,
): ImportedConversation {
  const turns: ImportedTurn[] = [];

  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let model: string | undefined;
  let startedAtMs = Number.POSITIVE_INFINITY;
  let startedAt: string | undefined;
  let endedAtMs = Number.NEGATIVE_INFINITY;
  let endedAt: string | undefined;
  let lastAssistantUuid: string | undefined;

  /** The turn currently being filled, or null before the first content. */
  let currentTurn: ImportedTurn | null = null;
  /** Global tool_use_id → tool call, for stitching results across boundaries. */
  const toolCallsById = new Map<string, ImportedToolCall>();
  /** Sidechain record uuid → owning agentId. */
  const agentIdByUuid = new Map<string, string>();
  /** agentId → sub-agent model. */
  const subAgentById = new Map<string, ImportedSubAgent>();
  /** Pending Task tool calls in the current turn, for description matching. */
  let pendingTasks: ImportedToolCall[] = [];

  const openTurn = (userMessage: ImportedTurn["userMessage"]): ImportedTurn => {
    const turn: ImportedTurn = {
      userMessage,
      assistantText: "",
      toolCalls: [],
      subAgents: [],
    };
    turns.push(turn);
    pendingTasks = [];
    return turn;
  };

  const ensureTurn = (): ImportedTurn => {
    if (currentTurn === null) {
      currentTurn = openTurn({ text: "", timestamp: undefined, uuid: undefined });
    }
    return currentTurn;
  };

  for (const raw of records) {
    const record = asRecord(raw);
    if (record === null) continue;

    try {
      const type = asString(record["type"]);
      if (type === undefined) continue;

      // Conversation-level metadata (first non-empty wins for stable fields).
      cwd ??= nonEmpty(asString(record["cwd"]));
      gitBranch ??= nonEmpty(asString(record["gitBranch"]));

      const timestamp = asString(record["timestamp"]);
      if (timestamp !== undefined) {
        const ms = Date.parse(timestamp);
        if (!Number.isNaN(ms)) {
          if (ms < startedAtMs) {
            startedAtMs = ms;
            startedAt = timestamp;
          }
          if (ms > endedAtMs) {
            endedAtMs = ms;
            endedAt = timestamp;
          }
        }
      }

      if (BOOKKEEPING_TYPES.has(type)) continue;

      const isSidechain = record["isSidechain"] === true;
      const isMeta = record["isMeta"] === true;
      const uuid = asString(record["uuid"]);
      const parentUuid = asString(record["parentUuid"]);
      const message = asRecord(record["message"]);

      if (type === "assistant") {
        if (message === null) continue;
        model ??= nonEmpty(asString(message["model"]));

        if (isSidechain) {
          const agent = resolveSubAgent({
            uuid,
            parentUuid,
            agentIdByUuid,
            subAgentById,
            currentTurn: ensureTurn(),
            description: undefined,
            pendingTasks,
          });
          applyAssistantBlockToSubAgent(agent, message, toolCallsById);
          continue;
        }

        if (uuid !== undefined) lastAssistantUuid = uuid;
        applyAssistantBlock(ensureTurn(), message, toolCallsById, pendingTasks);
        continue;
      }

      if (type === "user") {
        if (message === null) continue;
        const content = message["content"];
        const resultBlock = toolResultBlock(content);

        // Tool-result carrier: stitch onto the originating tool call, never a
        // turn boundary.
        if (resultBlock !== null) {
          applyToolResult(resultBlock, record["toolUseResult"], toolCallsById);
          continue;
        }

        // Meta records (slash-command stdout, skill preamble, …) are ignored
        // and never start a turn.
        if (isMeta) continue;

        if (isSidechain) {
          // Sidechain user prompt — roots or continues a sub-agent.
          resolveSubAgent({
            uuid,
            parentUuid,
            agentIdByUuid,
            subAgentById,
            currentTurn: ensureTurn(),
            description: nonEmpty(extractUserText(content)),
            pendingTasks,
          });
          continue;
        }

        // A real user prompt opens a new turn.
        currentTurn = openTurn({
          text: extractUserText(content),
          timestamp,
          uuid,
        });
        continue;
      }

      // Any other type is bookkeeping we do not model.
    } catch {
      // Never let one malformed record abort the whole parse.
      continue;
    }
  }

  return {
    sessionId: opts.sessionId,
    cwd,
    gitBranch,
    model,
    startedAt,
    endedAt,
    lastAssistantUuid,
    turns,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-record application helpers                                             */
/* -------------------------------------------------------------------------- */

function applyAssistantBlock(
  turn: ImportedTurn,
  message: Record<string, unknown>,
  toolCallsById: Map<string, ImportedToolCall>,
  pendingTasks: ImportedToolCall[],
): void {
  const block = assistantBlock(message);
  if (block === null) return;
  const blockType = block["type"];

  if (blockType === "text") {
    const text = asString(block["text"]);
    if (text !== undefined && text.length > 0) {
      turn.assistantText = turn.assistantText.length > 0 ? `${turn.assistantText}${text}` : text;
    }
    return;
  }

  if (blockType === "thinking") return; // Not durable — dropped.

  if (blockType === "tool_use") {
    const call = makeToolCall(block);
    if (call === null) return;
    turn.toolCalls.push(call);
    toolCallsById.set(call.toolUseId, call);
    if (call.toolName === "Task") pendingTasks.push(call);
  }
}

function applyAssistantBlockToSubAgent(
  agent: ImportedSubAgent,
  message: Record<string, unknown>,
  toolCallsById: Map<string, ImportedToolCall>,
): void {
  const block = assistantBlock(message);
  if (block === null) return;
  const blockType = block["type"];

  if (blockType === "text") {
    const text = asString(block["text"]);
    if (text !== undefined && text.length > 0) {
      agent.resultSummary =
        agent.resultSummary && agent.resultSummary.length > 0
          ? `${agent.resultSummary}${text}`
          : text;
      agent.status = "completed";
    }
    return;
  }

  if (blockType === "thinking") return;

  if (blockType === "tool_use") {
    const call = makeToolCall(block, agent.agentId, agent.taskId);
    if (call === null) return;
    agent.toolCalls.push(call);
    toolCallsById.set(call.toolUseId, call);
  }
}

function makeToolCall(
  block: Record<string, unknown>,
  agentId?: string,
  parentToolUseId?: string,
): ImportedToolCall | null {
  const toolUseId = asString(block["id"]);
  const toolName = asString(block["name"]);
  if (toolUseId === undefined || toolName === undefined) return null;
  const input = asRecord(block["input"]) ?? {};
  const call: ImportedToolCall = {
    toolUseId,
    toolName,
    input,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
  };
  return call;
}

function applyToolResult(
  block: Record<string, unknown>,
  toolUseResult: unknown,
  toolCallsById: Map<string, ImportedToolCall>,
): void {
  const toolUseId = asString(block["tool_use_id"]);
  if (toolUseId === undefined) return;
  const call = toolCallsById.get(toolUseId);
  if (call === undefined) return;

  const blockContent = block["content"];
  const content =
    blockContent !== undefined && blockContent !== null && blockContent !== ""
      ? stringifyContent(blockContent)
      : stringifyContent(toolUseResult);

  const isError = block["is_error"] === true;
  call.result = { content, ...(isError ? { isError: true } : {}) };
}

/**
 * Resolves (creating on first sight) the sub-agent that owns a sidechain record,
 * attaching it to the enclosing turn. See module "Assumptions".
 */
function resolveSubAgent(args: {
  uuid: string | undefined;
  parentUuid: string | undefined;
  agentIdByUuid: Map<string, string>;
  subAgentById: Map<string, ImportedSubAgent>;
  currentTurn: ImportedTurn;
  description: string | undefined;
  pendingTasks: readonly ImportedToolCall[];
}): ImportedSubAgent {
  const { uuid, parentUuid, agentIdByUuid, subAgentById, currentTurn, description, pendingTasks } =
    args;

  // Inherit the agent of the parent sidechain record, if we have seen it.
  const inherited = parentUuid !== undefined ? agentIdByUuid.get(parentUuid) : undefined;
  const agentId = inherited ?? uuid ?? `agent-${subAgentById.size}`;
  if (uuid !== undefined) agentIdByUuid.set(uuid, agentId);

  let agent = subAgentById.get(agentId);
  if (agent === undefined) {
    // New sub-agent root — try to link it to a Task tool call by description.
    const taskId = matchTaskId(description, pendingTasks);
    agent = {
      ...(agentId !== undefined ? { agentId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(description !== undefined ? { description } : {}),
      toolCalls: [],
    };
    subAgentById.set(agentId, agent);
    currentTurn.subAgents.push(agent);
  } else if (agent.description === undefined && description !== undefined) {
    (agent as { description?: string }).description = description;
  }
  return agent;
}

/** Finds the id of a `Task` tool call whose input matches `description`. */
function matchTaskId(
  description: string | undefined,
  pendingTasks: readonly ImportedToolCall[],
): string | undefined {
  if (description === undefined) return undefined;
  for (const task of pendingTasks) {
    const prompt = asString(task.input["prompt"]);
    const desc = asString(task.input["description"]);
    if (prompt === description || desc === description) return task.toolUseId;
  }
  return undefined;
}
