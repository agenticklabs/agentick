/**
 * ADR 82 — the hook cascade wired end-to-end through the construction fold.
 *
 * Proves that `createApp({ hooks })` and `createSession({ hooks })` reach a
 * real tool dispatch: the app folds its declarative `CommandHooks` into its
 * resolved `Hooks` layer, `createSessionBody` extends it with the session's
 * own layer, and the resolved value threads into the per-session
 * `ToolExecutorHarness`. `tool:dispatch` routes through `runOperation`, so the
 * folded hooks fire as middleware around the dispatch body — the handler sees
 * the reshaped input.
 *
 * `tool:dispatch` is the command this test exercises end-to-end; many other
 * built-in verbs now carry `CommandRegistry` augmentations too (see
 * `docs/proposals/v2/HOOK-LIFECYCLE.md`), so their `onBefore/After` keys are
 * likewise type-safe. Harnesses without an augmentation still receive the same
 * resolved `Hooks` VALUE and route through `runOperation`, but stay TYPE-dormant
 * until they augment `CommandRegistry`.
 *
 * @see docs/proposals/v2/blueprint/82-hooks-cascade-as-construction-fold.md
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { KnobsHarness } from "@agentick/knobs";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { CommandHooks } from "@agentick/runtime";
import type { ContentBlock, ToolDeclaration, ToolHandler } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "hooks-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "ok" } satisfies ContentBlock],
            stopReason: "end",
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

const ECHO_REF = "h.echo";

/** A dispatch-exposed tool whose handler echoes back the `value` it received. */
function echoTool(): ToolDeclaration {
  return {
    id: "t.echo",
    name: "echo",
    description: "echoes its input.value",
    inputSchema: jsonSchema({ type: "object" }),
    exposure: ["model", "dispatch"],
    handlerRef: ECHO_REF,
  };
}

/** Records + echoes the arguments the handler was actually invoked with. */
function makeEchoHandler(seen: { value?: unknown }): ToolHandler {
  return async (input) => {
    const value = (input as { value?: unknown }).value;
    seen.value = value;
    return [{ type: "text", text: String(value) } satisfies ContentBlock];
  };
}

describe("ADR 82 — hook cascade wired end-to-end (tool:dispatch)", () => {
  it("createApp({ hooks: { onBeforeToolDispatch } }) reshapes the dispatched input", async () => {
    const seen: { value?: unknown } = {};
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
      hooks: {
        onBeforeToolDispatch: (input) => ({
          ...input,
          input: { ...(input.input as Record<string, unknown>), value: "reshaped-by-app" },
        }),
      },
    });

    const session = await app.createSession();
    const result = await session.tools.dispatch("echo", { value: "original" });

    // The app-level before-hook fired around the real dispatch body: both the
    // handler AND the returned content reflect the reshaped input.
    expect(seen.value).toBe("reshaped-by-app");
    expect((result[0] as { text: string }).text).toBe("reshaped-by-app");

    await app.closeApp();
  });

  it("createSession({ hooks }) COMPOSES on top of app hooks (both fire, app outer)", async () => {
    const seen: { value?: unknown } = {};
    // Each before-hook APPENDS a marker. If both fire and the app layer is
    // outer, the handler sees the app suffix applied before the session suffix.
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
      hooks: {
        onBeforeToolDispatch: (input) => ({
          ...input,
          input: {
            ...(input.input as Record<string, unknown>),
            value: `${(input.input as { value: string }).value}|app`,
          },
        }),
      },
    });

    const session = await app.createSession({
      hooks: {
        onBeforeToolDispatch: (input) => ({
          ...input,
          input: {
            ...(input.input as Record<string, unknown>),
            value: `${(input.input as { value: string }).value}|session`,
          },
        }),
      },
    });

    const result = await session.tools.dispatch("echo", { value: "x" });

    // Compose, not override: BOTH ran. Outer-first ordering → app before session.
    expect(seen.value).toBe("x|app|session");
    expect((result[0] as { text: string }).text).toBe("x|app|session");

    await app.closeApp();
  });

  it("onAfterToolDispatch TRANSFORMS the DispatchResult and the change reaches session.tools.dispatch()", async () => {
    const seen: { value?: unknown } = {};
    let afterRan = 0;
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
      hooks: {
        // Transform, soundly: the registry now declares `tool:dispatch` output
        // as the richer `DispatchResult`, so the hook receives one and returns
        // one — rewriting `content` without stripping `isError`/metadata. Proves
        // after-transforms flow through to `session.tools.dispatch()`, not just observe.
        onAfterToolDispatch: (output) => {
          afterRan++;
          return {
            ...output,
            content: [{ type: "text", text: "reshaped-by-after" }],
          };
        },
      },
    });

    const session = await app.createSession();
    const result = await session.tools.dispatch("echo", { value: "untouched" });

    // The handler ran unchanged; the after-transform rewrote the surfaced content.
    expect(seen.value).toBe("untouched");
    expect(afterRan).toBe(1);
    expect((result[0] as { text: string }).text).toBe("reshaped-by-after");

    await app.closeApp();
  });

  it("behavior-preserving: no hooks → the handler sees the raw input", async () => {
    const seen: { value?: unknown } = {};
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
    });

    const session = await app.createSession();
    const result = await session.tools.dispatch("echo", { value: "verbatim" });

    expect(seen.value).toBe("verbatim");
    expect((result[0] as { text: string }).text).toBe("verbatim");

    await app.closeApp();
  });
});

/**
 * A `hooks:` / `guards:` field accepts a LIST of bags — one layer per element,
 * in list order. Contributor modules stop pre-merging with a spread, which
 * dropped one of two same-key entries before the framework ever saw the loser.
 */
describe("declarative bags accept a LIST — collisions compose instead of clobbering", () => {
  /** Suffixes the dispatched `value`, so ordering is legible in the result. */
  const appendBefore = (suffix: string): CommandHooks => ({
    onBeforeToolDispatch: (input) => ({
      ...input,
      input: {
        ...(input.input as Record<string, unknown>),
        value: `${(input.input as { value: string }).value}|${suffix}`,
      },
    }),
  });

  it("two app bags naming the SAME hook key both fire, in list order", async () => {
    const seen: { value?: unknown } = {};
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
      hooks: [appendBefore("audit"), appendBefore("redaction")],
    });

    const session = await app.createSession();
    await session.tools.dispatch("echo", { value: "x" });

    expect(seen.value).toBe("x|audit|redaction");

    await app.closeApp();
  });

  it("two around-form hooks on the same key NEST — earlier element outer", async () => {
    const order: string[] = [];
    const around = (name: string): CommandHooks => ({
      onToolDispatch: async (input, next) => {
        order.push(`${name}:in`);
        const out = await next(input);
        order.push(`${name}:out`);
        return out;
      },
    });
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler({})]]),
      hooks: [around("outer"), around("inner")],
    });

    const session = await app.createSession();
    await session.tools.dispatch("echo", { value: "x" });

    expect(order).toEqual(["outer:in", "inner:in", "inner:out", "outer:out"]);

    await app.closeApp();
  });

  it("two guard bags on the same command both run, and EITHER can veto", async () => {
    const consulted: string[] = [];
    const seen: { value?: unknown } = {};
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
      guards: [
        {
          toolDispatch: (input) => {
            consulted.push("policy");
            return (input.input as { value: string }).value === "banned-by-policy"
              ? { kind: "veto" as const, reason: "policy" }
              : undefined;
          },
        },
        {
          toolDispatch: (input) => {
            consulted.push("quota");
            return (input.input as { value: string }).value === "banned-by-quota"
              ? { kind: "veto" as const, reason: "quota" }
              : undefined;
          },
        },
      ],
    });

    const session = await app.createSession();
    await session.tools.dispatch("echo", { value: "fine" });
    expect(consulted).toEqual(["policy", "quota"]);
    expect(seen.value).toBe("fine");

    await expect(session.tools.dispatch("echo", { value: "banned-by-quota" })).rejects.toThrow(
      /veto/,
    );
    await expect(session.tools.dispatch("echo", { value: "banned-by-policy" })).rejects.toThrow(
      /veto/,
    );
    expect(seen.value).toBe("fine");

    await app.closeApp();
  });

  it("createSession({ hooks: [...] }) composes app-outer, exactly as one bag does", async () => {
    const seen: { value?: unknown } = {};
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
      hooks: appendBefore("app"),
    });

    const session = await app.createSession({
      hooks: [appendBefore("s1"), appendBefore("s2")],
    });
    await session.tools.dispatch("echo", { value: "x" });

    expect(seen.value).toBe("x|app|s1|s2");

    await app.closeApp();
  });
});

/**
 * ADR 83 §4 — LIVE interceptor inheritance end-to-end through the REAL tree.
 *
 * The construction-fold tests above register hooks at `createApp` time. These
 * prove the LATE case: a hook registered on the app AFTER a session already
 * exists cascades down the live app→session→sub edges to reach that session's
 * per-session harnesses — the gateway→app→session requirement, exercised at the
 * app level (a gateway hook folds into the app identically once the gateway
 * links). Proven against TWO distinct session-subtree harnesses, not the
 * app-shared executor/loop spine:
 *   - the per-session tool-executor (`tool:dispatch`, a direct app child)
 *   - the session's knobs bridge (`knobs:set`, the deepest app→session→knobs
 *     2-hop edge)
 */
describe("ADR 83 §4 — late app registration reaches already-constructed per-session subs", () => {
  it("app.hook + app.use registered AFTER createSession reach the tool-executor AND the knobs bridge", async () => {
    const seen: { value?: unknown } = {};
    const app = await createApp(React.createElement(Agent), {
      modelExecutor: await mkExecutor(),
      tools: [echoTool()],
      toolHandlers: new Map([[ECHO_REF, makeEchoHandler(seen)]]),
    });

    // Session (and its per-session subs) constructed with NOTHING registered on
    // the app yet — the frozen fold would have snapshotted an empty layer here.
    const session = await app.createSession();

    // LATE registrations on the app, AFTER the session + its subs exist.
    const seenOpIds: string[] = [];
    app.use(async (input, next, ctx) => {
      if (ctx.opId !== undefined) seenOpIds.push(ctx.opId);
      return next(input);
    });
    app.hook({
      onBeforeToolDispatch: (input) => ({
        ...input,
        input: { ...(input.input as Record<string, unknown>), value: "reshaped-late" },
      }),
    });

    // (1) per-session TOOL-EXECUTOR dispatch — the late app.hook reshaped the
    // input, so it reached `tool:dispatch` on a harness built before it.
    const result = await session.tools.dispatch("echo", { value: "original" });
    expect(seen.value).toBe("reshaped-late");
    expect((result[0] as { text: string }).text).toBe("reshaped-late");

    // (2) SESSION → KNOBS bridge (the deepest, 2-hop edge). The late app.use
    // wrapped the `knobs:set` op on the session's own knobs harness — proving
    // the cascade reaches a grandchild, not just the app's direct children.
    const knobs = (session as unknown as { bridges: { knobs: KnobsHarness } }).bridges.knobs;
    await knobs.set({ id: "flag", value: "on" });
    expect(knobs.get("flag")).toBe("on");
    expect(seenOpIds.some((id) => id.startsWith("knobs:set"))).toBe(true);

    await app.closeApp();
  });
});
