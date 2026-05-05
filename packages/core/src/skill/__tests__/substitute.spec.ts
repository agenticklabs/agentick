/**
 * substituteSkillVars — $ substitution per Agent Skills spec.
 *
 * Adversarial coverage:
 * - $ARGUMENTS with object, string, scalar
 * - $ARGUMENTS[N] / $N positional with declared argumentNames + with object args
 * - $name lookup
 * - ${VAR} env-style substitution
 * - Unknown $name / ${VAR} left literal (no throw)
 * - Multi-occurrence
 * - Edge cases: empty args, missing names
 */

import { describe, it, expect } from "vitest";
import { substituteSkillVars, templateUsesArguments } from "../substitute.js";

describe("substituteSkillVars", () => {
  describe("$ARGUMENTS — full args", () => {
    it("substitutes a string args directly", () => {
      const out = substituteSkillVars("Run: $ARGUMENTS", { args: "fix login bug" });
      expect(out).toBe("Run: fix login bug");
    });

    it("substitutes an object args as JSON", () => {
      const out = substituteSkillVars("Args: $ARGUMENTS", {
        args: { issueNumber: 42, branch: "main" },
      });
      expect(out).toContain("Args:");
      expect(out).toContain("42");
      expect(out).toContain("main");
    });

    it("renders empty when args is undefined", () => {
      const out = substituteSkillVars("Got: $ARGUMENTS", {});
      expect(out).toBe("Got: ");
    });

    it("substitutes multiple occurrences", () => {
      const out = substituteSkillVars("$ARGUMENTS / $ARGUMENTS", { args: "x" });
      expect(out).toBe("x / x");
    });
  });

  describe("$N / $ARGUMENTS[N] — positional", () => {
    it("indexes string args via shell tokenization", () => {
      const out = substituteSkillVars("First=$0 Second=$1 Third=$2", {
        args: "alpha beta gamma",
      });
      expect(out).toBe("First=alpha Second=beta Third=gamma");
    });

    it("respects quoted multi-word string args", () => {
      const out = substituteSkillVars("First=$0 Second=$1", {
        args: '"hello world" rest',
      });
      expect(out).toBe("First=hello world Second=rest");
    });

    it("indexes object args by argumentNames order", () => {
      const out = substituteSkillVars("$0 → $1 → $2", {
        args: { component: "SearchBar", from: "React", to: "Vue" },
        argumentNames: ["component", "from", "to"],
      });
      expect(out).toBe("SearchBar → React → Vue");
    });

    it("indexes object args by insertion order when argumentNames absent", () => {
      const out = substituteSkillVars("$0 then $1", {
        args: { a: "first", b: "second" },
      });
      expect(out).toBe("first then second");
    });

    it("$ARGUMENTS[N] is equivalent to $N", () => {
      const out = substituteSkillVars("$ARGUMENTS[0] / $0", { args: "X Y" });
      expect(out).toBe("X / X");
    });

    it("out-of-range index left literal", () => {
      const out = substituteSkillVars("$0 $5", { args: "only" });
      expect(out).toBe("only $5");
    });
  });

  describe("$name — named", () => {
    it("looks up keys on object args", () => {
      const out = substituteSkillVars("Issue $issueNumber on $branch", {
        args: { issueNumber: 42, branch: "main" },
      });
      expect(out).toBe("Issue 42 on main");
    });

    it("maps positional string args to declared names", () => {
      const out = substituteSkillVars("Migrate $component from $from to $to", {
        args: "SearchBar React Vue",
        argumentNames: ["component", "from", "to"],
      });
      expect(out).toBe("Migrate SearchBar from React to Vue");
    });

    it("unknown name left literal", () => {
      const out = substituteSkillVars("Hi $unknown", { args: { other: 1 } });
      expect(out).toBe("Hi $unknown");
    });
  });

  describe("${VAR} — env-style", () => {
    it("substitutes from vars map", () => {
      const out = substituteSkillVars("session=${AGENTICK_SESSION_ID}", {
        vars: { AGENTICK_SESSION_ID: "abc-123" },
      });
      expect(out).toBe("session=abc-123");
    });

    it("unknown var left literal", () => {
      const out = substituteSkillVars("x=${UNSET}", {});
      expect(out).toBe("x=${UNSET}");
    });

    it("supports skill dir reference", () => {
      const out = substituteSkillVars("Run ${AGENTICK_SKILL_DIR}/scripts/x.sh", {
        vars: { AGENTICK_SKILL_DIR: "/opt/skills/build" },
      });
      expect(out).toBe("Run /opt/skills/build/scripts/x.sh");
    });
  });

  describe("ordering: $ARGUMENTS not eaten by $name", () => {
    it("$ARGUMENTS resolves to args, not as a name lookup", () => {
      const out = substituteSkillVars("$ARGUMENTS", {
        args: { ARGUMENTS: "bogus", real: "value" },
      });
      // The literal $ARGUMENTS form wins over name-lookup-of-ARGUMENTS
      expect(out).toContain("real");
      expect(out).toContain("value");
    });
  });
});

describe("templateUsesArguments", () => {
  it("detects $ARGUMENTS", () => {
    expect(templateUsesArguments("foo $ARGUMENTS bar")).toBe(true);
  });
  it("detects $0", () => {
    expect(templateUsesArguments("$0")).toBe(true);
  });
  it("detects $ARGUMENTS[0]", () => {
    expect(templateUsesArguments("$ARGUMENTS[0]")).toBe(true);
  });
  it("returns false when only $name appears", () => {
    expect(templateUsesArguments("hello $name")).toBe(false);
  });
  it("returns false on plain text", () => {
    expect(templateUsesArguments("no substitutions here")).toBe(false);
  });
});
