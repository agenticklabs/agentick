import { describe, it, expect } from "vitest";
import { matchPattern, evaluateRules, deny, allow } from "./policy.js";

describe("matchPattern", () => {
  it("exact match", () => {
    expect(matchPattern("search", "search")).toBe(true);
    expect(matchPattern("search", "find")).toBe(false);
  });

  it("wildcard * matches everything", () => {
    expect(matchPattern("anything", "*")).toBe(true);
    expect(matchPattern("", "*")).toBe(true);
  });

  it("* at end (prefix match)", () => {
    expect(matchPattern("file_read", "file_*")).toBe(true);
    expect(matchPattern("file_write", "file_*")).toBe(true);
    expect(matchPattern("exec_run", "file_*")).toBe(false);
  });

  it("* at start (suffix match)", () => {
    expect(matchPattern("read_admin", "*_admin")).toBe(true);
    expect(matchPattern("write_admin", "*_admin")).toBe(true);
    expect(matchPattern("admin_read", "*_admin")).toBe(false);
  });

  it("* in middle", () => {
    expect(matchPattern("file_v2_read", "file_*_read")).toBe(true);
    expect(matchPattern("file__read", "file_*_read")).toBe(true);
    expect(matchPattern("file_v2_write", "file_*_read")).toBe(false);
  });

  it("no match returns false", () => {
    expect(matchPattern("search", "find")).toBe(false);
    expect(matchPattern("a", "b")).toBe(false);
  });
});

describe("evaluateRules", () => {
  it("first match wins — deny before allow", () => {
    const rules = [deny("search"), allow("search")];
    const result = evaluateRules("search", rules);
    expect(result).toBe(rules[0]);
    expect(result!.action).toBe("deny");
  });

  it("first match wins — allow before deny", () => {
    const rules = [allow("search"), deny("search")];
    const result = evaluateRules("search", rules);
    expect(result).toBe(rules[0]);
    expect(result!.action).toBe("allow");
  });

  it("no match returns null", () => {
    const rules = [deny("exec_*"), allow("file_*")];
    expect(evaluateRules("search", rules)).toBeNull();
  });

  it("matches by pattern within rule", () => {
    const rules = [deny("file_delete", "exec_*")];
    expect(evaluateRules("file_delete", rules)?.action).toBe("deny");
    expect(evaluateRules("exec_run", rules)?.action).toBe("deny");
    expect(evaluateRules("file_read", rules)).toBeNull();
  });
});

describe("deny()", () => {
  it("creates correct rule shape", () => {
    const rule = deny("file_delete", "exec_*");
    expect(rule).toEqual({
      patterns: ["file_delete", "exec_*"],
      action: "deny",
    });
  });
});

describe("allow()", () => {
  it("creates correct rule shape", () => {
    const rule = allow("file_read", "search");
    expect(rule).toEqual({
      patterns: ["file_read", "search"],
      action: "allow",
    });
  });
});
