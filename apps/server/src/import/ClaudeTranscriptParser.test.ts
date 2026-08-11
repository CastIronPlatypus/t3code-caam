import { describe, expect, it } from "@effect/vitest";

import { parseClaudeTranscript, type ClaudeTranscriptRecord } from "./ClaudeTranscriptParser.ts";

const SESSION = "c9bcbd4c-5a60-408c-84ea-e07493adb57c";
const CWD = "/data/projects/t3code";
const BRANCH = "main";

let clock = 0;
/** Monotonic ISO timestamp so records land in a deterministic order. */
function ts(): string {
  clock += 1;
  const mm = String(Math.floor(clock / 60) % 60).padStart(2, "0");
  const ss = String(clock % 60).padStart(2, "0");
  return `2026-08-11T19:${mm}:${ss}.000Z`;
}

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function base(overrides: Partial<ClaudeTranscriptRecord>): ClaudeTranscriptRecord {
  return {
    uuid: id("u"),
    parentUuid: null,
    sessionId: SESSION,
    cwd: CWD,
    gitBranch: BRANCH,
    timestamp: ts(),
    isSidechain: false,
    ...overrides,
  };
}

/** A real user prompt whose content is a plain string. */
function userString(text: string, overrides: Partial<ClaudeTranscriptRecord> = {}) {
  return base({ type: "user", message: { role: "user", content: text }, ...overrides });
}

/** A real user prompt whose content is an array of text blocks. */
function userBlocks(texts: readonly string[], overrides: Partial<ClaudeTranscriptRecord> = {}) {
  return base({
    type: "user",
    message: { role: "user", content: texts.map((text) => ({ type: "text", text })) },
    ...overrides,
  });
}

function assistantText(text: string, overrides: Partial<ClaudeTranscriptRecord> = {}) {
  return base({
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text }] },
    ...overrides,
  });
}

function assistantThinking(text: string, overrides: Partial<ClaudeTranscriptRecord> = {}) {
  return base({
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "thinking", thinking: text }],
    },
    ...overrides,
  });
}

function assistantToolUse(
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
  overrides: Partial<ClaudeTranscriptRecord> = {},
) {
  return base({
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "tool_use", id: toolUseId, name, input }],
    },
    ...overrides,
  });
}

function toolResult(
  toolUseId: string,
  content: unknown,
  overrides: Partial<ClaudeTranscriptRecord> = {},
) {
  return base({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
    toolUseResult: content,
    ...overrides,
  });
}

describe("parseClaudeTranscript", () => {
  it("reconstructs conversation-level metadata", () => {
    const records = [userString("hello"), assistantText("hi there")];
    const convo = parseClaudeTranscript(records, { sessionId: SESSION });

    expect(convo.sessionId).toBe(SESSION);
    expect(convo.cwd).toBe(CWD);
    expect(convo.gitBranch).toBe(BRANCH);
    expect(convo.model).toBe("claude-opus-4-8");
    expect(convo.startedAt).toBe(records[0]?.timestamp);
    expect(convo.endedAt).toBe(records[1]?.timestamp);
    expect(convo.lastAssistantUuid).toBe(records[1]?.uuid);
    expect(convo.turns).toHaveLength(1);
  });

  it("handles string and block user content", () => {
    const stringPrompt = userString("first prompt");
    const blockPrompt = userBlocks(["line one", "line two"]);
    const convo = parseClaudeTranscript(
      [stringPrompt, assistantText("a"), blockPrompt, assistantText("b")],
      { sessionId: SESSION },
    );

    expect(convo.turns).toHaveLength(2);
    expect(convo.turns[0]?.userMessage.text).toBe("first prompt");
    expect(convo.turns[0]?.userMessage.uuid).toBe(stringPrompt.uuid);
    expect(convo.turns[1]?.userMessage.text).toBe("line one\nline two");
  });

  it("joins multi-block assistant text and excludes thinking", () => {
    const convo = parseClaudeTranscript(
      [
        userString("do it"),
        assistantThinking("secret reasoning"),
        assistantText("Part one. "),
        assistantText("Part two."),
      ],
      { sessionId: SESSION },
    );

    expect(convo.turns).toHaveLength(1);
    expect(convo.turns[0]?.assistantText).toBe("Part one. Part two.");
    expect(convo.turns[0]?.assistantText).not.toContain("secret reasoning");
  });

  it("matches tool_use to tool_result (string content)", () => {
    const toolUseId = id("toolu");
    const convo = parseClaudeTranscript(
      [
        userString("run ls"),
        assistantToolUse(toolUseId, "Bash", { command: "ls" }),
        toolResult(toolUseId, "file-a\nfile-b"),
      ],
      { sessionId: SESSION },
    );

    const call = convo.turns[0]?.toolCalls[0];
    expect(call?.toolUseId).toBe(toolUseId);
    expect(call?.toolName).toBe("Bash");
    expect(call?.input).toEqual({ command: "ls" });
    expect(call?.result).toEqual({ content: "file-a\nfile-b" });
  });

  it("matches tool_result carried as text blocks and flags errors", () => {
    const toolUseId = id("toolu");
    const convo = parseClaudeTranscript(
      [
        userString("break it"),
        assistantToolUse(toolUseId, "Read", { file_path: "/nope" }),
        toolResult(toolUseId, [{ type: "text", text: "ENOENT" }], {
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                is_error: true,
                content: [{ type: "text", text: "ENOENT" }],
              },
            ],
          },
        }),
      ],
      { sessionId: SESSION },
    );

    const call = convo.turns[0]?.toolCalls[0];
    expect(call?.result?.content).toBe("ENOENT");
    expect(call?.result?.isError).toBe(true);
  });

  it("skips isMeta user records without starting a turn", () => {
    const convo = parseClaudeTranscript(
      [
        base({
          type: "user",
          isMeta: true,
          message: { role: "user", content: "<local-command-stdout>x" },
        }),
        userString("real prompt"),
        assistantText("ok"),
        base({ type: "user", isMeta: true, message: { role: "user", content: "more meta" } }),
      ],
      { sessionId: SESSION },
    );

    expect(convo.turns).toHaveLength(1);
    expect(convo.turns[0]?.userMessage.text).toBe("real prompt");
  });

  it("ignores bookkeeping and malformed records without throwing", () => {
    const convo = parseClaudeTranscript(
      [
        base({ type: "mode" }),
        base({ type: "file-history-snapshot" }),
        base({ type: "queue-operation" }),
        null as unknown as ClaudeTranscriptRecord,
        { type: "assistant" } as ClaudeTranscriptRecord, // no message
        userString("hi"),
        assistantText("yo"),
      ],
      { sessionId: SESSION },
    );

    expect(convo.turns).toHaveLength(1);
    expect(convo.turns[0]?.assistantText).toBe("yo");
  });

  it("groups sidechain records into a sub-agent and links it to its Task", () => {
    const taskId = id("toolu-task");
    const subToolId = id("toolu-sub");
    const agentUuid = "agent-root-uuid";
    const agentChildUuid = "agent-child-uuid";

    const convo = parseClaudeTranscript(
      [
        userString("spawn an agent"),
        assistantText("Launching a sub-agent."),
        assistantToolUse(taskId, "Task", {
          description: "explore repo",
          prompt: "explore repo",
        }),
        // Sidechain root: its own user prompt (the task).
        base({
          type: "user",
          isSidechain: true,
          uuid: agentUuid,
          parentUuid: null,
          message: { role: "user", content: "explore repo" },
        }),
        // Sidechain assistant tool call, chained under the root.
        base({
          type: "assistant",
          isSidechain: true,
          uuid: agentChildUuid,
          parentUuid: agentUuid,
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "tool_use", id: subToolId, name: "Grep", input: { pattern: "foo" } }],
          },
        }),
        // Result of the sidechain tool call.
        base({
          type: "user",
          isSidechain: true,
          parentUuid: agentChildUuid,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: subToolId, content: "match!" }],
          },
        }),
        // Sidechain final assistant text — the agent result summary.
        base({
          type: "assistant",
          isSidechain: true,
          parentUuid: agentChildUuid,
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "Found it." }],
          },
        }),
        // The Task's own result in the main conversation.
        toolResult(taskId, "agent done"),
      ],
      { sessionId: SESSION },
    );

    expect(convo.turns).toHaveLength(1);
    const turn = convo.turns[0];
    // The Task tool call lives in the main turn and got its result.
    expect(turn?.toolCalls.map((c) => c.toolName)).toEqual(["Task"]);
    expect(turn?.toolCalls[0]?.result?.content).toBe("agent done");

    // One sub-agent, linked to the Task by description.
    expect(turn?.subAgents).toHaveLength(1);
    const agent = turn?.subAgents[0];
    expect(agent?.agentId).toBe(agentUuid);
    expect(agent?.taskId).toBe(taskId);
    expect(agent?.description).toBe("explore repo");
    expect(agent?.resultSummary).toBe("Found it.");
    expect(agent?.status).toBe("completed");

    // Sub-agent tool call carries agentId + parentToolUseId and its result.
    expect(agent?.toolCalls).toHaveLength(1);
    const subCall = agent?.toolCalls[0];
    expect(subCall?.toolName).toBe("Grep");
    expect(subCall?.agentId).toBe(agentUuid);
    expect(subCall?.parentToolUseId).toBe(taskId);
    expect(subCall?.result?.content).toBe("match!");
  });

  it("handles multiple turns with interleaved tool calls", () => {
    const t1 = id("toolu");
    const convo = parseClaudeTranscript(
      [
        userString("turn one"),
        assistantText("working"),
        assistantToolUse(t1, "Bash", { command: "pwd" }),
        toolResult(t1, "/data"),
        assistantText(" done"),
        userString("turn two"),
        assistantText("second answer"),
      ],
      { sessionId: SESSION },
    );

    expect(convo.turns).toHaveLength(2);
    expect(convo.turns[0]?.assistantText).toBe("working done");
    expect(convo.turns[0]?.toolCalls).toHaveLength(1);
    expect(convo.turns[0]?.toolCalls[0]?.result?.content).toBe("/data");
    expect(convo.turns[1]?.userMessage.text).toBe("turn two");
    expect(convo.turns[1]?.assistantText).toBe("second answer");
    expect(convo.turns[1]?.toolCalls).toHaveLength(0);
  });

  it("attaches pre-prompt assistant content to a leading empty-user turn", () => {
    const convo = parseClaudeTranscript(
      [assistantText("resumed mid-stream"), userString("now a prompt"), assistantText("reply")],
      { sessionId: SESSION },
    );

    expect(convo.turns).toHaveLength(2);
    expect(convo.turns[0]?.userMessage.text).toBe("");
    expect(convo.turns[0]?.assistantText).toBe("resumed mid-stream");
    expect(convo.turns[1]?.userMessage.text).toBe("now a prompt");
  });

  it("returns an empty-but-valid model for a transcript of only bookkeeping", () => {
    const convo = parseClaudeTranscript([base({ type: "mode" }), base({ type: "system" })], {
      sessionId: SESSION,
    });

    expect(convo.turns).toHaveLength(0);
    expect(convo.model).toBeUndefined();
    expect(convo.lastAssistantUuid).toBeUndefined();
    expect(convo.cwd).toBe(CWD);
  });
});
