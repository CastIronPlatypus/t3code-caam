import { describe, expect, it } from "@effect/vitest";

import type {
  ImportedConversation,
  ImportedSubAgent,
  ImportedToolCall,
  ImportedTurn,
} from "./ClaudeTranscriptParser.ts";
import {
  buildImportPlan,
  DEFAULT_IMPORT_TITLE,
  type ImportActivityOp,
  type ImportAssistantMessageOp,
  type ImportPlanOperation,
  type ImportSessionSetOp,
  type ImportUserMessageOp,
} from "./ImportTranslator.ts";

const SESSION = "c9bcbd4c-5a60-408c-84ea-e07493adb57c";
const CWD = "/data/projects/t3code";
const OPTIONS = { instanceId: "claudeAgent", model: "claude-opus-4-8" } as const;

function turn(overrides: Partial<ImportedTurn> = {}): ImportedTurn {
  return {
    userMessage: { text: "hello", timestamp: "2026-08-11T19:00:00.000Z", uuid: "u1" },
    assistantText: "hi there",
    toolCalls: [],
    subAgents: [],
    ...overrides,
  };
}

function conversation(overrides: Partial<ImportedConversation> = {}): ImportedConversation {
  return {
    sessionId: SESSION,
    cwd: CWD,
    gitBranch: "main",
    model: "claude-opus-4-8",
    startedAt: "2026-08-11T19:00:00.000Z",
    endedAt: "2026-08-11T19:30:00.000Z",
    lastAssistantUuid: "assistant-uuid-last",
    turns: [turn()],
    ...overrides,
  };
}

function toolCall(overrides: Partial<ImportedToolCall> = {}): ImportedToolCall {
  return {
    toolUseId: "tool-1",
    toolName: "Bash",
    input: { command: "ls -la" },
    result: { content: "file-a\nfile-b" },
    ...overrides,
  };
}

/** Narrows the ops list to a single op of the given discriminant. */
function opsOf<K extends ImportPlanOperation["op"]>(
  ops: readonly ImportPlanOperation[],
  op: K,
): Extract<ImportPlanOperation, { op: K }>[] {
  return ops.filter((o): o is Extract<ImportPlanOperation, { op: K }> => o.op === op);
}

describe("buildImportPlan", () => {
  it("derives thread creation info from the conversation", () => {
    const plan = buildImportPlan(conversation(), OPTIONS);
    expect(plan.thread.threadId).toBe(`thread:${SESSION}`);
    expect(plan.thread.title).toBe("hello");
    expect(plan.thread.modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-4-8",
    });
    expect(plan.thread.cwd).toBe(CWD);
    expect(plan.thread.gitBranch).toBe("main");
    expect(plan.thread.runtimeMode).toBe("full-access");
    expect(plan.thread.createdAt).toBe("2026-08-11T19:00:00.000Z");
  });

  it("derives a truncated single-line title from the first user prompt", () => {
    const longText = `First line ${"x".repeat(200)}\nsecond line`;
    const plan = buildImportPlan(
      conversation({
        turns: [turn({ userMessage: { text: longText, timestamp: undefined, uuid: undefined } })],
      }),
      OPTIONS,
    );
    expect(plan.thread.title.length).toBeLessThanOrEqual(81); // 80 + ellipsis
    expect(plan.thread.title.endsWith("…")).toBe(true);
    expect(plan.thread.title).not.toContain("\n");
  });

  it("falls back to the default title when there is no user text", () => {
    const plan = buildImportPlan(
      conversation({
        turns: [turn({ userMessage: { text: "", timestamp: undefined, uuid: undefined } })],
      }),
      OPTIONS,
    );
    expect(plan.thread.title).toBe(DEFAULT_IMPORT_TITLE);
  });

  it("emits ordered ops with correct user/assistant text and ids for a multi-turn conversation", () => {
    const plan = buildImportPlan(
      conversation({
        turns: [
          turn({ userMessage: { text: "q1", timestamp: "t1", uuid: "u1" }, assistantText: "a1" }),
          turn({ userMessage: { text: "q2", timestamp: "t2", uuid: "u2" }, assistantText: "a2" }),
        ],
      }),
      OPTIONS,
    );

    const kinds = plan.operations.map((o) => o.op);
    expect(kinds).toEqual([
      "session-set", // turn 0 running
      "user-message",
      "assistant-message",
      "session-set", // turn 1 running
      "user-message",
      "assistant-message",
      "session-set", // final stopped
    ]);

    const users = opsOf(plan.operations, "user-message");
    expect(users.map((u: ImportUserMessageOp) => u.text)).toEqual(["q1", "q2"]);
    expect(users.map((u: ImportUserMessageOp) => u.messageId)).toEqual([
      `msg:${SESSION}:0:user`,
      `msg:${SESSION}:1:user`,
    ]);
    // The user prompt is a decider-bypass append.
    for (const u of users) expect(u.mode).toBe("bypass-append");

    const assistants = opsOf(plan.operations, "assistant-message");
    expect(assistants.map((a: ImportAssistantMessageOp) => a.text)).toEqual(["a1", "a2"]);
    expect(assistants.map((a: ImportAssistantMessageOp) => a.messageId)).toEqual([
      `msg:${SESSION}:0:assistant`,
      `msg:${SESSION}:1:assistant`,
    ]);
    expect(assistants.map((a: ImportAssistantMessageOp) => a.turnId)).toEqual([
      `turn:${SESSION}:0`,
      `turn:${SESSION}:1`,
    ]);
  });

  it("puts the user message before the assistant reply and session running before both", () => {
    const plan = buildImportPlan(conversation(), OPTIONS);
    const first = plan.operations[0] as ImportSessionSetOp;
    expect(first.op).toBe("session-set");
    expect(first.session.status).toBe("running");
    expect(first.session.activeTurnId).toBe(`turn:${SESSION}:0`);

    const userIndex = plan.operations.findIndex((o) => o.op === "user-message");
    const assistantIndex = plan.operations.findIndex((o) => o.op === "assistant-message");
    expect(userIndex).toBeLessThan(assistantIndex);
    expect(userIndex).toBeGreaterThan(0);
  });

  it("skips the assistant-message op when the assistant text is empty", () => {
    const plan = buildImportPlan(
      conversation({
        turns: [turn({ assistantText: "" })],
      }),
      OPTIONS,
    );
    expect(opsOf(plan.operations, "assistant-message")).toHaveLength(0);
    // The user message is still emitted.
    expect(opsOf(plan.operations, "user-message")).toHaveLength(1);
  });

  it("emits tool.started + tool.completed activities in order with the right payload", () => {
    const plan = buildImportPlan(
      conversation({
        turns: [
          turn({
            assistantText: "running a command",
            toolCalls: [
              toolCall({
                toolUseId: "tc-1",
                toolName: "Bash",
                input: { command: "ls" },
                result: { content: "out" },
              }),
            ],
          }),
        ],
      }),
      OPTIONS,
    );

    const activities = opsOf(plan.operations, "activity").map((a: ImportActivityOp) => a.activity);
    expect(activities.map((a) => a.kind)).toEqual(["tool.started", "tool.completed"]);

    const started = activities[0];
    expect(started?.tone).toBe("tool");
    expect(started?.summary).toBe("Bash started");
    expect(started?.payload).toMatchObject({ itemType: "Bash", detail: "ls" });
    expect(started?.turnId).toBe(`turn:${SESSION}:0`);

    const completed = activities[1];
    expect(completed?.tone).toBe("tool");
    expect(completed?.summary).toBe("Bash");
    expect(completed?.payload).toMatchObject({ itemType: "Bash", detail: "out" });
  });

  it("omits tool.completed when the tool call has no result", () => {
    const noResult: ImportedToolCall = {
      toolUseId: "tc-x",
      toolName: "Read",
      input: { file_path: "a.ts" },
    };
    const plan = buildImportPlan(
      conversation({
        turns: [turn({ toolCalls: [noResult] })],
      }),
      OPTIONS,
    );
    const kinds = opsOf(plan.operations, "activity").map((a: ImportActivityOp) => a.activity.kind);
    expect(kinds).toEqual(["tool.started"]);
  });

  it("emits task.started + nested tool activities + task.completed for a sub-agent", () => {
    const subAgent: ImportedSubAgent = {
      agentId: "agent-abc",
      taskId: "task-xyz",
      description: "explore the repo",
      status: "completed",
      resultSummary: "found 3 files",
      toolCalls: [
        {
          toolUseId: "sub-tc-1",
          toolName: "Grep",
          input: { pattern: "foo" },
          result: { content: "match" },
          agentId: "agent-abc",
          parentToolUseId: "task-xyz",
        },
      ],
    };
    const plan = buildImportPlan(
      conversation({
        turns: [
          turn({
            assistantText: "delegating",
            toolCalls: [
              toolCall({
                toolUseId: "task-xyz",
                toolName: "Task",
                input: { prompt: "explore the repo" },
                result: { content: "done" },
              }),
            ],
            subAgents: [subAgent],
          }),
        ],
      }),
      OPTIONS,
    );

    const activities = opsOf(plan.operations, "activity").map((a: ImportActivityOp) => a.activity);
    expect(activities.map((a) => a.kind)).toEqual([
      "tool.started", // the Task tool call itself
      "tool.completed",
      "task.started", // sub-agent
      "tool.started", // nested Grep
      "tool.completed",
      "task.completed",
    ]);

    const taskStarted = activities[2];
    expect(taskStarted?.kind).toBe("task.started");
    expect(taskStarted?.tone).toBe("info");
    expect(taskStarted?.payload).toMatchObject({
      taskId: "task-xyz",
      agentId: "agent-abc",
      detail: "explore the repo",
    });

    const nestedStarted = activities[3];
    expect(nestedStarted?.payload).toMatchObject({
      itemType: "Grep",
      agentId: "agent-abc",
      parentToolUseId: "task-xyz",
    });

    const taskCompleted = activities[5];
    expect(taskCompleted?.kind).toBe("task.completed");
    expect(taskCompleted?.payload).toMatchObject({
      taskId: "task-xyz",
      status: "completed",
      summary: "found 3 files",
      agentId: "agent-abc",
    });
  });

  it("produces a correct resume binding descriptor", () => {
    const plan = buildImportPlan(
      conversation({
        turns: [turn(), turn()],
        lastAssistantUuid: "last-uuid",
      }),
      OPTIONS,
    );
    expect(plan.binding).toEqual({
      sessionId: SESSION,
      resume: SESSION,
      resumeSessionAt: "last-uuid",
      turnCount: 2,
      cwd: CWD,
      model: "claude-opus-4-8",
      instanceId: "claudeAgent",
    });
  });

  it("ends the plan with a stopped session-set", () => {
    const plan = buildImportPlan(conversation(), OPTIONS);
    const last = plan.operations[plan.operations.length - 1] as ImportSessionSetOp;
    expect(last.op).toBe("session-set");
    expect(last.session.status).toBe("stopped");
    expect(last.session.activeTurnId).toBeNull();
    expect(last.createdAt).toBe("2026-08-11T19:30:00.000Z");
  });
});
