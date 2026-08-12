import { describe, expect, it } from "@effect/vitest";

import { parseProjectDefaults, resolveProjectDefault } from "./ProjectDefaults.ts";

describe("parseProjectDefaults", () => {
  it("parses a JSON array and defaults the tool to claude", () => {
    const defaults = parseProjectDefaults(
      JSON.stringify([{ path: "/data/projects/app", profile: "a@example.com" }]),
      undefined,
    );
    expect(defaults).toEqual([
      { path: "/data/projects/app", tool: "claude", profile: "a@example.com" },
    ]);
  });

  it("honors an explicit tool and normalizes the path", () => {
    const defaults = parseProjectDefaults(
      JSON.stringify([{ path: "/data/projects/app/", profile: "b@example.com", tool: "codex" }]),
      undefined,
    );
    expect(defaults).toEqual([
      { path: "/data/projects/app", tool: "codex", profile: "b@example.com" },
    ]);
  });

  it("skips entries missing a non-empty path or profile", () => {
    const defaults = parseProjectDefaults(
      JSON.stringify([
        { path: "", profile: "a@example.com" },
        { path: "/x", profile: "" },
        { path: "/x" },
        { profile: "c@example.com" },
        { path: "/good", profile: "good@example.com" },
      ]),
      undefined,
    );
    expect(defaults).toEqual([{ path: "/good", tool: "claude", profile: "good@example.com" }]);
  });

  it("tolerates malformed JSON by returning an empty list", () => {
    expect(parseProjectDefaults("{ not json", undefined)).toEqual([]);
    expect(parseProjectDefaults("", undefined)).toEqual([]);
    expect(parseProjectDefaults("{}", undefined)).toEqual([]);
    expect(parseProjectDefaults("null", undefined)).toEqual([]);
  });

  it("appends the single-default convenience rooted at / with tool claude", () => {
    const defaults = parseProjectDefaults(undefined, "solo@example.com");
    expect(defaults).toEqual([{ path: "/", tool: "claude", profile: "solo@example.com" }]);
    expect(resolveProjectDefault(defaults, "/anywhere/at/all", "claude")).toBe("solo@example.com");
  });
});

describe("resolveProjectDefault", () => {
  const seed = parseProjectDefaults(
    JSON.stringify([{ path: "/data/projects/thrivelist_mvp", profile: "marcello@thrivalist.com" }]),
    undefined,
  );

  it("matches the seed project exactly", () => {
    expect(resolveProjectDefault(seed, "/data/projects/thrivelist_mvp", "claude")).toBe(
      "marcello@thrivalist.com",
    );
  });

  it("matches a nested directory under the seed project", () => {
    expect(
      resolveProjectDefault(seed, "/data/projects/thrivelist_mvp/apps/web/src", "claude"),
    ).toBe("marcello@thrivalist.com");
  });

  it("picks the longest matching prefix", () => {
    const defaults = parseProjectDefaults(
      JSON.stringify([
        { path: "/a", profile: "outer@example.com" },
        { path: "/a/b", profile: "inner@example.com" },
      ]),
      undefined,
    );
    expect(resolveProjectDefault(defaults, "/a/b/c", "claude")).toBe("inner@example.com");
    expect(resolveProjectDefault(defaults, "/a/x", "claude")).toBe("outer@example.com");
  });

  it("does not match across a segment boundary", () => {
    const defaults = parseProjectDefaults(
      JSON.stringify([{ path: "/a/b", profile: "p@example.com" }]),
      undefined,
    );
    expect(resolveProjectDefault(defaults, "/a/bc", "claude")).toBeUndefined();
    expect(resolveProjectDefault(defaults, "/a/bcd/e", "claude")).toBeUndefined();
  });

  it("filters by tool", () => {
    const defaults = parseProjectDefaults(
      JSON.stringify([{ path: "/a", profile: "codex@example.com", tool: "codex" }]),
      undefined,
    );
    expect(resolveProjectDefault(defaults, "/a/b", "codex")).toBe("codex@example.com");
    expect(resolveProjectDefault(defaults, "/a/b", "claude")).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveProjectDefault(seed, "/other/place", "claude")).toBeUndefined();
    expect(resolveProjectDefault([], "/a", "claude")).toBeUndefined();
  });
});
