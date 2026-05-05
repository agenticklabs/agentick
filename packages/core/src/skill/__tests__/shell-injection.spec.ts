/**
 * shell-injection — parsing and applying skill body shell directives.
 *
 * Adversarial coverage:
 * - Inline `!`cmd`` parsing (basic, multiple, nested in surrounding text)
 * - Block ```!\ncmd\n``` parsing (single + multi-line commands)
 * - Inlines inside blocks are NOT double-counted
 * - Order preservation in mixed inline + block bodies
 * - applyShellInjections runs serially in document order
 * - Runner errors wrap with command + position context
 * - No injections case is identity
 */

import { describe, it, expect, vi } from "vitest";
import {
  findShellInjections,
  bodyHasShellInjections,
  applyShellInjections,
} from "../shell-injection.js";

describe("findShellInjections — inline form", () => {
  it("parses a single inline command", () => {
    const body = "Diff: !`git diff HEAD`";
    const found = findShellInjections(body);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "inline", command: "git diff HEAD" });
  });

  it("parses multiple inline commands in order", () => {
    // `!` must be at line-start or follow whitespace — see RE_INLINE comment
    const body = "A= !`one` B= !`two` C= !`three`";
    const found = findShellInjections(body);
    expect(found.map((f) => f.command)).toEqual(["one", "two", "three"]);
    // Sorted by position
    expect(found[0]!.start).toBeLessThan(found[1]!.start);
    expect(found[1]!.start).toBeLessThan(found[2]!.start);
  });

  it("does not match plain backtick spans (without leading !)", () => {
    const body = "`not a shell call`";
    expect(findShellInjections(body)).toEqual([]);
  });

  it("requires whitespace or line-start before `!` (skips prose-glued forms)", () => {
    // `prose!`grep`` is most likely an accidental glue, not an intended
    // injection — we don't execute it.
    expect(findShellInjections("prose!`should-not-run`")).toEqual([]);
    // Line-start: matches
    expect(findShellInjections("!`runs`")).toHaveLength(1);
    // After whitespace: matches
    expect(findShellInjections("ok !`runs`")).toHaveLength(1);
  });
});

describe("findShellInjections — block form", () => {
  it("parses a single block with one command", () => {
    const body = ["```!", "node --version", "```"].join("\n");
    const found = findShellInjections(body);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "block", command: "node --version" });
  });

  it("parses a block with multi-line commands", () => {
    const body = ["```!", "node --version", "git status --short", "```"].join("\n");
    const found = findShellInjections(body);
    expect(found).toHaveLength(1);
    expect(found[0]!.command).toBe("node --version\ngit status --short");
  });

  it("parses multiple blocks in order", () => {
    const body = ["```!", "first", "```", "", "## Section", "", "```!", "second", "```"].join("\n");
    const found = findShellInjections(body);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.command)).toEqual(["first", "second"]);
  });
});

describe("findShellInjections — mixed forms", () => {
  it("does not double-count inlines inside a block", () => {
    const body = ["Some text !`outer-cmd`", "```!", "echo `inside` !`also-inside`", "```"].join(
      "\n",
    );
    const found = findShellInjections(body);
    // outer-cmd (inline) + the entire block. The !`also-inside` is inside the
    // block range, so it's NOT counted as a separate injection.
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.kind)).toEqual(["inline", "block"]);
    expect(found[0]!.command).toBe("outer-cmd");
    expect(found[1]!.kind).toBe("block");
  });

  it("returns injections in document order", () => {
    const body = ["First !`a` then", "```!", "b", "```", "and !`c`"].join("\n");
    const found = findShellInjections(body);
    expect(found.map((f) => f.command)).toEqual(["a", "b", "c"]);
  });
});

describe("bodyHasShellInjections", () => {
  it("returns true for inline", () => {
    expect(bodyHasShellInjections("ok !`cmd` ok")).toBe(true);
  });
  it("returns true for block", () => {
    expect(bodyHasShellInjections("```!\nx\n```")).toBe(true);
  });
  it("returns false for plain text", () => {
    expect(bodyHasShellInjections("nothing here")).toBe(false);
  });
});

describe("applyShellInjections", () => {
  it("identity-returns body when no injections", async () => {
    const out = await applyShellInjections("plain text", async () => "should not call");
    expect(out).toBe("plain text");
  });

  it("substitutes a single inline command output", async () => {
    const runner = vi.fn(async (cmd: string) => `[result of ${cmd}]`);
    const out = await applyShellInjections("Diff:\n!`git diff`\n", runner);
    expect(out).toBe("Diff:\n[result of git diff]\n");
    expect(runner).toHaveBeenCalledWith("git diff");
  });

  it("substitutes a block command output", async () => {
    const runner = vi.fn(async () => "Node v22\n");
    const body = ["Env:", "```!", "node --version", "```", "Done."].join("\n");
    const out = await applyShellInjections(body, runner);
    expect(out).toBe("Env:\nNode v22\n\nDone.");
  });

  it("runs commands serially in document order", async () => {
    const order: string[] = [];
    const runner = async (cmd: string): Promise<string> => {
      // Stagger to verify serial execution: the second call must wait for the first
      await new Promise((r) => setTimeout(r, 5));
      order.push(cmd);
      return `[${cmd}]`;
    };
    const body = "!`first` !`second` !`third`";
    const out = await applyShellInjections(body, runner);
    expect(order).toEqual(["first", "second", "third"]);
    expect(out).toBe("[first] [second] [third]");
  });

  it("wraps runner errors with command + position context", async () => {
    const runner = async () => {
      throw new Error("no Bash mounted");
    };
    await expect(applyShellInjections("x !`fail` y", runner)).rejects.toThrow(
      /Skill shell injection failed at offset \d+.*inline command `fail`.*no Bash mounted/,
    );
  });

  it("preserves surrounding text exactly (no extra escaping)", async () => {
    const runner = async () => "OUTPUT";
    // Whitespace before `!` (regex requires line-start or whitespace)
    const out = await applyShellInjections("before: !`x` :after", runner);
    expect(out).toBe("before: OUTPUT :after");
  });
});
