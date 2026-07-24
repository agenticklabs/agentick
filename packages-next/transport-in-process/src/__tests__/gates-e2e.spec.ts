/**
 * Full-stack gates round-trip — sanity net over the real wire.
 *
 * Structural twin of the `tasks/cancel` e2e: gates commands are plain
 * request/response wire methods, but — unlike tasks (a porcelain
 * `tasksWireExtension`) — gates rides the GENERIC dynamic-command lane. So this
 * test doubles as the dynamic-lane e2e: `gates/list` / `gates/clear` /
 * `gates/defer` / `gates/override` resolve through `createDynamicCommandResolver`
 * (SESSION_SURFACES ⊇ "gates") → `inbox.ask("gates:<sid>:gates", …)` →
 * `GatesHarness` command → the ONE controller. Drives it through the REAL
 * `GatewayHarness` + `inProcessTransport` (no stub JSON-RPC handler) via the
 * client `session.gates` handle (ADR 87).
 *
 * Side-effect import of `@agentick/gates-next` types/registers the server-side
 * `SessionHarnessProtocol.gates` surface; `/client` registers `session.gates`.
 */

import "@agentick/gates-next";
import "@agentick/gates-next/client";

import { describe, expect, it } from "vitest";

import { createClient } from "@agentick/client-core-next";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { createGateway } from "@agentick/gateway-next";
import { fakeCompiler } from "@agentick/compiler-next/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { gate } from "@agentick/gates-next";
import { ErrorCode, type ContentBlock, type WireMethod } from "@agentick/spec-next";

import { inProcessTransport } from "../index.js";

async function makeStack() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const executor = new FakeLanguageModelExecutor("e2e-gates-exec", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "ok" } satisfies ContentBlock],
          stopReason: "end",
        },
      },
    ],
  });
  await executor.ready;

  const gateway = await createGateway();
  await gateway.listen();
  const app = await gateway.createApp({
    appId: "gates-app",
    rootElement: null,
    options: { modelExecutor: executor, compiler: fakeCompiler() },
  });
  // `session.gates` is a built-in bridge constructed unconditionally per session
  // (ADR 26/27); the GatesHarness owns the controller behind it.
  const session = await app.createSession({ sessionId: "gates-session" });

  // Register a verified gate (predicate-cleared, host/wire override-only) and a
  // latch gate (model/host cleared) on the server session's ONE controller.
  session.gates.register(
    "inv",
    gate({ description: "Invariant", instructions: "hold", satisfied: () => false }),
  );
  session.gates.register(
    "review",
    gate({ description: "Await review", instructions: "review", activateWhen: () => false }),
  );

  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();

  return {
    client,
    session,
    sessionId: session.id,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("gates end-to-end — client ↔ gateway (dynamic lane) ↔ session", () => {
  it("gates.list() round-trips the server gate registry", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const gates = client.session(sessionId).gates;
    const rows = await gates.refresh();

    const byName = new Map(rows.map((g) => [g.name, g]));
    expect(byName.get("inv")).toMatchObject({ name: "inv", verified: true });
    expect(byName.get("review")).toMatchObject({ name: "review", verified: false });

    await cleanup();
  });

  it("gates.clear(name) releases the server gate over the wire", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();

    // Engage the verified gate host-side (the audited escape), then clear it over
    // the wire. No tick fires, so clear's release sticks (nothing re-engages it).
    session.gate("inv")?.override("active", "setup");
    expect(session.gate("inv")?.value).toBe("active");

    await client.session(sessionId).gates.clear("inv");

    expect(session.gate("inv")?.value).toBe("inactive");

    await cleanup();
  });

  it("gates.defer(name) postpones a latch gate over the wire", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();

    await client.session(sessionId).gates.defer("review", "later");

    expect(session.gate("review")?.value).toBe("deferred");

    await cleanup();
  });

  it("gates.override(name, value, reason) mutates the verified gate over the wire", async () => {
    const { client, session, sessionId, cleanup } = await makeStack();

    await client.session(sessionId).gates.override("inv", "active", "manual unblock");

    expect(session.gate("inv")?.value).toBe("active");

    await cleanup();
  });

  it("commands/list enumerates the wire-exposed gate verbs", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const reply = (await client.transport.request(
      "commands/list" as WireMethod,
      {
        sessionId,
      } as never,
    )) as { commands: Array<{ method: string }> };

    const methods = reply.commands.map((c) => c.method);
    for (const m of ["gates/list", "gates/clear", "gates/defer", "gates/override"]) {
      expect(methods).toContain(m);
    }

    await cleanup();
  });

  it("an undeclared gates verb is MethodNotFound (deny-by-default)", async () => {
    const { client, sessionId, cleanup } = await makeStack();

    const err = await client.transport
      .request("gates/frobnicate" as WireMethod, { sessionId } as never)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeDefined();
    // Canonical TransportError shape: `{ kind: "rpc", error: { code: -32601 } }`.
    const e = err as { code?: number; error?: { code?: number } };
    expect(e.error?.code ?? e.code).toBe(ErrorCode.MethodNotFound);

    await cleanup();
  });
});
