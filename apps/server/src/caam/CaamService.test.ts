import { describe, expect, it } from "@effect/vitest";

import { caamToolForDriverKind, parseCaamEnvOutput, parseCaamLsOutput } from "./CaamService.ts";

describe("parseCaamLsOutput", () => {
  it("maps profiles from a caam ls --json payload", () => {
    const stdout = JSON.stringify({
      profiles: [
        {
          tool: "claude",
          name: "jeffhaskin1@gmail.com",
          active: false,
          system: false,
          health: { ok: true },
          identity: { email: "jeffhaskin1@gmail.com" },
        },
        {
          tool: "claude",
          name: "host-capture",
          active: true,
          system: true,
        },
      ],
      count: 2,
    });
    expect(parseCaamLsOutput(stdout, "claude")).toEqual([
      { tool: "claude", name: "jeffhaskin1@gmail.com", active: false, system: false },
      { tool: "claude", name: "host-capture", active: true, system: true },
    ]);
  });

  it("defaults active/system to false and falls back to the requested tool", () => {
    const stdout = JSON.stringify({ profiles: [{ name: "solo@example.com" }] });
    expect(parseCaamLsOutput(stdout, "codex")).toEqual([
      { tool: "codex", name: "solo@example.com", active: false, system: false },
    ]);
  });

  it("skips entries without a usable name", () => {
    const stdout = JSON.stringify({
      profiles: [{ name: "" }, { active: true }, { name: "keep@example.com" }],
    });
    expect(parseCaamLsOutput(stdout, "claude")).toEqual([
      { tool: "claude", name: "keep@example.com", active: false, system: false },
    ]);
  });

  it("returns [] on malformed JSON or an unexpected shape", () => {
    expect(parseCaamLsOutput("not json", "claude")).toEqual([]);
    expect(parseCaamLsOutput("", "claude")).toEqual([]);
    expect(parseCaamLsOutput(JSON.stringify({ nope: 1 }), "claude")).toEqual([]);
    expect(parseCaamLsOutput(JSON.stringify([]), "claude")).toEqual([]);
  });
});

describe("parseCaamEnvOutput", () => {
  it("parses exported shell lines into an environment map", () => {
    const stdout = [
      'export HOME="/home/jeff/.caam/claude/jeffhaskin1"',
      'export XDG_CONFIG_HOME="/home/jeff/.caam/claude/jeffhaskin1/.config"',
      'export CLAUDE_CONFIG_DIR="/home/jeff/.caam/claude/jeffhaskin1/.config/claude"',
      "# caam env for claude/jeffhaskin1@gmail.com",
    ].join("\n");
    expect(parseCaamEnvOutput(stdout, 0)).toEqual({
      HOME: "/home/jeff/.caam/claude/jeffhaskin1",
      XDG_CONFIG_HOME: "/home/jeff/.caam/claude/jeffhaskin1/.config",
      CLAUDE_CONFIG_DIR: "/home/jeff/.caam/claude/jeffhaskin1/.config/claude",
    });
  });

  it("accepts lines without the export keyword and skips blanks/comments", () => {
    const stdout = ["", "# comment", 'FOO="bar"', "  ", "BAZ=qux"].join("\n");
    expect(parseCaamEnvOutput(stdout, 0)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("unescapes Go-style double-quoted values", () => {
    const stdout = ['export A="a\\"b"', 'export B="line1\\nline2"', 'export C="tab\\there"'].join(
      "\n",
    );
    expect(parseCaamEnvOutput(stdout, 0)).toEqual({
      A: 'a"b',
      B: "line1\nline2",
      C: "tab\there",
    });
  });

  it("returns {} when caam prints a leading false token", () => {
    expect(parseCaamEnvOutput("false  # no such profile", 0)).toEqual({});
    expect(parseCaamEnvOutput("false", 0)).toEqual({});
  });

  it("returns {} on a non-zero exit code even with output", () => {
    expect(parseCaamEnvOutput('export HOME="/home/jeff"', 1)).toEqual({});
  });
});

describe("caamToolForDriverKind", () => {
  it("maps known driver kinds", () => {
    expect(caamToolForDriverKind("claudeAgent")).toBe("claude");
    expect(caamToolForDriverKind("codex")).toBe("codex");
  });

  it("returns undefined for unknown driver kinds", () => {
    expect(caamToolForDriverKind("cursor")).toBeUndefined();
    expect(caamToolForDriverKind("")).toBeUndefined();
  });
});
