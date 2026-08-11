/**
 * The `code` namespace at the adopter's entry point — `createApp({ code })`.
 *
 * Conformance certifies the parts; this is the configuration an adopter
 * actually writes. It pins the three states the harness has (bound, inert,
 * absent) and the `ctx.code` door a code-mode tool reaches through.
 *
 * @verifiedBy this file
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../react.js";
import { defineCode, withCode, type Code } from "@agentick/code";
import { fakeCode, fakeCodeHarness, fakeCodeSource } from "@agentick/code/testing";
import type { ContentBlock, SessionExtension, ToolHandler } from "@agentick/spec";
import { jsonSchema, toRegistration } from "@agentick/spec";

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "code host");

describe("createApp({ code }) — the adopter entry point", () => {
  it("`code: {}` mounts the DEFAULT runtime — naming the namespace is enough", async () => {
    const app = await createApp(React.createElement(Agent), { code: {} });
    const session = await app.createSession({ sessionId: "s-code-default" });

    expect(session.code).toBeDefined();
    expect(session.code!.hasRuntime()).toBe(true);
    // Whichever engine is running this test is the one the programs run on.
    expect(session.code!.capabilities().name).toMatch(/^host:/);

    // A real subprocess, reached with no configuration at all.
    const result = await session.code!.run({ source: `return 6 * 7;` });
    expect(result).toMatchObject({ outcome: "returned", value: 42 });

    await session.close();
    await app.close();
  });

  it("a bare withCode() resolves the same default", async () => {
    const app = await createApp(React.createElement(Agent), { extensions: [withCode()] });
    const session = await app.createSession({ sessionId: "s-code-default-ext" });

    expect(session.code!.capabilities().name).toMatch(/^host:/);
    const result = await session.code!.run({ source: `return "zero config";` });
    expect(result).toMatchObject({ outcome: "returned", value: "zero config" });

    await session.close();
    await app.close();
  });

  it("definition-level bindings and budgets are the base every program gets", async () => {
    const app = await createApp(React.createElement(Agent), {
      code: defineCode({
        bindings: { tools: { whoami: async () => "acme" } },
        budgets: { timeMs: 5_000 },
      }),
    });
    const session = await app.createSession({ sessionId: "s-code-layered" });

    const result = await session.code!.run({ source: `return await tools.whoami({});` });
    expect(result).toMatchObject({ outcome: "returned", value: "acme" });

    await session.close();
    await app.close();
  });

  it("a bound runtime round-trips through session.code.run", async () => {
    const app = await createApp(React.createElement(Agent), {
      code: defineCode({ runtime: fakeCode() }),
    });
    const session = await app.createSession({ sessionId: "s-code-bound" });

    expect(session.code).toBeDefined();
    // The render-time bridge and the adopter surface are ONE instance.
    const bridges = (session as unknown as { readonly bridges: Record<string, unknown> }).bridges;
    expect(bridges.code).toBe(session.code);

    const result = await session.code!.run({
      source: fakeCodeSource.callsBinding("tools.recall", { q: "hi" }),
      bindings: { tools: { recall: async (input: unknown) => ({ echoed: input }) } },
    });

    expect(result.outcome).toBe("returned");
    if (result.outcome === "returned") expect(result.value).toEqual({ echoed: { q: "hi" } });

    await session.close();
    await app.close();
  });

  it("an adopter-owned harness with no runtime yet is present and fails CodeProviderMissing", async () => {
    // The slot demands a runtime, so the only way to install without one is to
    // build the harness yourself and bind later — the live-instance arm, whose
    // lifecycle stays the adopter's (no onClose).
    const { harness, close: closeHarness } = await fakeCodeHarness();
    const app = await createApp(React.createElement(Agent), { code: harness });
    const session = await app.createSession({ sessionId: "s-code-unbound" });

    // A FACADE over the adopter's instance, not the instance — so session
    // teardown cannot close what the adopter owns. It delegates everything else.
    expect(session.code).not.toBe(harness);
    expect(session.code!.id).toBe(harness.id);
    expect(session.code!.hasRuntime()).toBe(false);
    await expect(session.code!.run({ source: fakeCodeSource.returns(1) })).rejects.toMatchObject({
      _tag: "CodeProviderMissing",
    });

    harness.bindRuntime(fakeCode());
    const result = await session.code!.run({ source: fakeCodeSource.returns("bound late") });
    expect(result).toMatchObject({ outcome: "returned", value: "bound late" });

    await session.close();
    await app.close();
    await closeHarness();
  });

  it("closing a session does NOT close an adopter-owned harness", async () => {
    // The session's teardown calls `close()` on every bridge that has one,
    // which is right for the harnesses it built and fatal for one it did not:
    // the first session to close would dispose a runtime meant to outlive it.
    const runtime = fakeCode();
    const disposed = vi.spyOn(runtime, "dispose");
    const { harness, close: closeHarness } = await fakeCodeHarness({ runtime });

    const app = await createApp(React.createElement(Agent), { code: harness });
    const first = await app.createSession({ sessionId: "s-adopted-1" });
    await first.close();

    expect(disposed).not.toHaveBeenCalled();
    // Still usable by the next session, which is the whole point of sharing it.
    const second = await app.createSession({ sessionId: "s-adopted-2" });
    const result = await second.code!.run({ source: fakeCodeSource.returns("still alive") });
    expect(result).toMatchObject({ outcome: "returned", value: "still alive" });

    await second.close();
    await app.close();
    expect(disposed).not.toHaveBeenCalled();

    // The adopter's own close is the one that ends it.
    await closeHarness();
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("an omitted slot installs nothing — no phantom namespace", async () => {
    const app = await createApp(React.createElement(Agent), {});
    const session = await app.createSession({ sessionId: "s-code-absent" });

    expect(session.code).toBeUndefined();

    await session.close();
    await app.close();
  });

  it("a tool handler reaches the same harness through ctx.code", async () => {
    let seen: unknown;
    const probe: SessionExtension = {
      name: "code-ctx-probe",
      target: "session",
      install: (installer) => {
        const handler: ToolHandler = async (_input, deps) => {
          const code = (deps as { readonly ctx: { readonly code?: Code } }).ctx.code;
          seen = await code?.run({ source: fakeCodeSource.returns("from ctx") });
          return [{ type: "text", text: "ok" } satisfies ContentBlock];
        };
        const handlerRef = `code-ctx-probe:${installer.sessionId}`;
        installer.registerToolHandler(handlerRef, handler);
        installer.registerExtensionTool(
          toRegistration(
            {
              id: handlerRef,
              name: "probe_code",
              description: "reads ctx.code",
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              exposure: ["dispatch"],
              handlerRef,
            },
            { scope: "extension", extensionName: "code-ctx-probe", level: "session" },
          ),
        );
      },
    };

    const app = await createApp(React.createElement(Agent), {
      code: defineCode({ runtime: fakeCode() }),
      extensions: [probe],
    });
    const session = await app.createSession({ sessionId: "s-code-ctx" });

    await session.tools.dispatch("probe_code", {});
    expect(seen).toMatchObject({ outcome: "returned", value: "from ctx" });

    await session.close();
    await app.close();
  });
});
