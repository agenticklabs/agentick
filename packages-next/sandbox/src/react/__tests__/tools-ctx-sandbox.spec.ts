/**
 * ADR 66 — the built-in sandbox tools resolve their harness from
 * `ctx.sandbox` (the app-scoped `SandboxBridge`, dispatch-resolved by
 * the executor) rather than the render-captured `use` bag.
 *
 * These tests call the tool handlers directly with a fabricated `ctx`
 * carrying a stub bridge, proving:
 *   - present  → the handler resolves `<Sandbox id="primary">` from the
 *                bridge and invokes it,
 *   - sole     → falls back to the only registered sandbox when no
 *                "primary" exists,
 *   - absent   → guards cleanly (`ctx.sandbox` undefined) with the
 *                "no sandbox available in scope" message.
 *
 * `useSandbox()` (the React hook) is unchanged and still covered by
 * `component.spec.tsx` for render-time use.
 */

import { describe, expect, it } from "vitest";
import type { ContentBlock, ToolHandler, ToolHandlerCtx } from "@agentick/spec-next";

import type { SandboxBridge, SandboxRegistration } from "../../bridge.js";
import type { SandboxHarness } from "../../harness.js";
import { Bash, EditFile, ReadFile, WriteFile } from "../tools.js";

/**
 * Invoke a built-in tool handler and narrow its return to blocks. The
 * built-in sandbox tools always return `ContentBlock[]` (never a
 * `TaskHandle`), so the cast is safe for these tests.
 */
async function run(
  handler: ToolHandler,
  input: unknown,
  ctx: ToolHandlerCtx,
): Promise<readonly ContentBlock[]> {
  return (await handler(input, { ctx, use: {} })) as readonly ContentBlock[];
}

/** A minimal `SandboxHarness` double — only the verbs the tools call. */
function stubHarness(over: Partial<SandboxHarness> = {}): SandboxHarness {
  return {
    exec: async () => ({ exitCode: 0, stdout: "hello", stderr: "" }),
    readFile: async () => "file-contents",
    writeFile: async () => undefined,
    editFile: async () => ({ applied: 1, changes: [{ line: 3, removed: 1, added: 2 }] }),
    ...over,
  } as unknown as SandboxHarness;
}

/**
 * A stub `SandboxBridge` backed by an explicit id→harness map. `get`
 * and `list` are the only surface the built-in tools touch.
 */
function stubBridge(entries: Record<string, SandboxHarness>): SandboxBridge {
  return {
    createHarness: async () => {
      throw new Error("not used");
    },
    register: () => () => {},
    unregister: () => {},
    get: (id: string) => entries[id],
    list: (): readonly SandboxRegistration[] =>
      Object.keys(entries).map((id) => ({ id, workspacePath: `/ws/${id}`, status: "ready" })),
    subscribe: () => () => {},
  };
}

function ctxWith(sandbox: SandboxBridge | undefined): ToolHandlerCtx {
  return { sandbox } as unknown as ToolHandlerCtx;
}

describe("built-in sandbox tools — ctx.sandbox resolution (ADR 66)", () => {
  it("bash resolves the primary sandbox from ctx.sandbox and runs it", async () => {
    let seen = "";
    const exec = (async (input: { command: string }) => {
      seen = input.command;
      return { exitCode: 0, stdout: "ran", stderr: "" };
    }) as unknown as SandboxHarness["exec"];
    const bridge = stubBridge({ primary: stubHarness({ exec }) });

    const out = await run(Bash.handler, { command: "ls -a" }, ctxWith(bridge));

    expect(seen).toBe("ls -a");
    expect(out).toEqual([{ type: "text", text: "ran" }]);
  });

  it("read_file / write_file / edit_file all source the harness from ctx.sandbox", async () => {
    const bridge = stubBridge({ primary: stubHarness() });
    const ctx = ctxWith(bridge);

    expect(await run(ReadFile.handler, { path: "/a.txt" }, ctx)).toEqual([
      { type: "text", text: "file-contents" },
    ]);
    expect(await run(WriteFile.handler, { path: "/a.txt", content: "hi" }, ctx)).toEqual([
      { type: "text", text: "Wrote 2 bytes to /a.txt" },
    ]);
    const edit = await run(
      EditFile.handler,
      { path: "/a.txt", edits: [{ old: "x", new: "y" }] },
      ctx,
    );
    expect(edit[0]).toMatchObject({ type: "text" });
  });

  it("falls back to the sole registered sandbox when there is no 'primary'", async () => {
    const exec = (async () => ({
      exitCode: 0,
      stdout: "sole",
      stderr: "",
    })) as unknown as SandboxHarness["exec"];
    const bridge = stubBridge({ "only-one": stubHarness({ exec }) });

    const out = await run(Bash.handler, { command: "echo hi" }, ctxWith(bridge));
    expect(out).toEqual([{ type: "text", text: "sole" }]);
  });

  it("guards cleanly when no sandbox is mounted (ctx.sandbox undefined)", async () => {
    const out = await run(Bash.handler, { command: "ls" }, ctxWith(undefined));
    expect(out).toEqual([{ type: "text", text: "Error: no sandbox available in scope" }]);
  });

  it("is ambiguous (no sandbox) when multiple non-primary sandboxes are registered", async () => {
    const bridge = stubBridge({ a: stubHarness(), b: stubHarness() });
    const out = await run(ReadFile.handler, { path: "/x" }, ctxWith(bridge));
    expect(out).toEqual([{ type: "text", text: "Error: no sandbox available in scope" }]);
  });
});
