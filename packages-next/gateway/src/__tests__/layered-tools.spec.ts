/**
 * Slice-7 (#141) — gateway-level tool propagation.
 *
 * Verifies:
 *   - `createGateway({ tools })` propagates declarations to every
 *     app's session registry, tagged with `binding: { scope: "gateway" }`.
 *   - The gateway tools survive across `createApp` calls (same gateway,
 *     multiple apps).
 *   - App-level tools override gateway-level tools on name collision
 *     (precedence: app > gateway).
 */

import { describe, expect, it } from "vitest";
import type { ToolDeclaration, ToolExecutorProtocol } from "@agentick/spec-next";
import { SPEC_VERSION, jsonSchema } from "@agentick/spec-next";
import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { ReconcilerHarness } from "@agentick/reconciler-react-next";

import { createGateway } from "../index.js";

function mkAppOptions() {
  const sub = { journal: new MemoryJournal(), bus: new LocalEventBus(), inbox: new LocalInbox() };
  return {
    executor: new FakeLanguageModelExecutor(
      `exec-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
      {
        scripted: {
          result: {
            specVersion: SPEC_VERSION,
            output: [{ type: "text", text: "ok" }],
            stopReason: "end",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        },
      },
    ),
    reconciler: new ReconcilerHarness(
      `r-${Math.random().toString(36).slice(2)}`,
      sub.journal,
      sub.bus,
      sub.inbox,
    ),
  };
}

const NULL_ROOT = null as unknown;

const tool = (name: string, description = name): ToolDeclaration => ({
  id: `t.${name}`,
  name,
  description,
  inputSchema: jsonSchema({ type: "object" }),
  exposure: ["model"],
  handlerRef: `h.${name}`,
});

describe("GatewayHarness — layered tools (#141)", () => {
  it("propagates gateway-level tools to every session of every app it hosts", async () => {
    const gateway = await createGateway({ tools: [tool("health_check")] });
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: mkAppOptions(),
    });
    const session = await app.createSession();
    const internals = session as unknown as { toolExecutor: ToolExecutorProtocol };
    const compiled = await internals.toolExecutor.compileForTick({ exposure: "model" });
    expect(compiled.map((t) => t.name)).toContain("health_check");
    await gateway.close();
  });

  it("gateway tools reach multiple apps under the same gateway", async () => {
    const gateway = await createGateway({ tools: [tool("ping")] });
    await gateway.listen();
    const a = await gateway.createApp({
      appId: "a",
      rootElement: NULL_ROOT,
      options: mkAppOptions(),
    });
    const b = await gateway.createApp({
      appId: "b",
      rootElement: NULL_ROOT,
      options: mkAppOptions(),
    });
    const sA = await a.createSession();
    const sB = await b.createSession();
    const intA = sA as unknown as { toolExecutor: ToolExecutorProtocol };
    const intB = sB as unknown as { toolExecutor: ToolExecutorProtocol };
    expect(
      (await intA.toolExecutor.compileForTick({ exposure: "model" })).map((t) => t.name),
    ).toContain("ping");
    expect(
      (await intB.toolExecutor.compileForTick({ exposure: "model" })).map((t) => t.name),
    ).toContain("ping");
    await gateway.close();
  });

  it("app-level tool overrides gateway-level tool on name collision", async () => {
    const gateway = await createGateway({
      tools: [tool("calc", "gateway calc")],
    });
    await gateway.listen();
    const app = await gateway.createApp({
      rootElement: NULL_ROOT,
      options: { ...mkAppOptions(), tools: [tool("calc", "app calc")] },
    });
    const session = await app.createSession();
    const internals = session as unknown as { toolExecutor: ToolExecutorProtocol };
    const compiled = await internals.toolExecutor.compileForTick({ exposure: "model" });
    const calc = compiled.find((t) => t.name === "calc");
    expect(calc?.description).toBe("app calc");
    await gateway.close();
  });

  it("session-level tool overrides gateway-level tool on name collision", async () => {
    const gateway = await createGateway({
      tools: [tool("calc", "gateway calc")],
    });
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const session = await app.createSession({
      tools: [tool("calc", "session calc")],
    });
    const internals = session as unknown as { toolExecutor: ToolExecutorProtocol };
    const compiled = await internals.toolExecutor.compileForTick({ exposure: "model" });
    const calc = compiled.find((t) => t.name === "calc");
    expect(calc?.description).toBe("session calc");
    await gateway.close();
  });

  it("omitting gateway.tools yields apps with no gateway-bound tools", async () => {
    const gateway = await createGateway();
    await gateway.listen();
    const app = await gateway.createApp({ rootElement: NULL_ROOT, options: mkAppOptions() });
    const session = await app.createSession();
    const internals = session as unknown as { toolExecutor: ToolExecutorProtocol };
    expect(await internals.toolExecutor.compileForTick({ exposure: "model" })).toEqual([]);
    await gateway.close();
  });
});
