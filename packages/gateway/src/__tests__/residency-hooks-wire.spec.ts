/**
 * Reproduction rig for the silent-residency-logger report (knowify,
 * 2026-08-22): app-level around-form residency hooks, constructed through the
 * GATEWAY door (`gateway.createApp`, not `/react`'s `createApp`), driven by
 * the wire `session/send` into a hibernated session — the exact production
 * flow. The app-door pin (session-eviction.spec) covers the react door; a
 * beacon-confirmed live deployment showed resumes with no hook firings, so
 * the divergence must be on this path if it is the framework's at all.
 */

import { describe, expect, it } from "vitest";

import { createTelemetry } from "@agentick/app";
import { waitFor } from "@agentick/utils/testing";

import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";
import type { ExecutionTarget, SessionHarnessProtocol } from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

import { GatewayHarness } from "../harness.js";
import { sessionWireExtension } from "../wire/session-extension.js";
import { fakeWireCtx } from "./fake-wire-ctx.js";

const NULL_ROOT = null as unknown;

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "mock",
  modelId: "mock-v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

describe("residency hooks through the gateway door + wire send", () => {
  it("a wire send into a hibernated session fires the around resume hook", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("gw-res", journal, bus, inbox, {
      scripted: {
        result: {
          specVersion: SPEC_VERSION,
          output: [{ type: "text", text: "ok" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    });
    await executor.ready;

    const seen: string[] = [];
    const gateway = new GatewayHarness({ journal, bus, inbox });
    await gateway.listen();
    const app = await gateway.createApp({
      appId: "residency-repro",
      rootElement: NULL_ROOT,
      options: {
        compiler: new CompilerHarness("r-residency", journal, bus, inbox),
        modelExecutor: executor,
        target,
        journal,
        bus,
        inbox,
        // Default node-local session store — in-process evict/resume works over it.
        // A MIXED bag like ernesto's: a session-command hook beside the
        // around-form residency keys — rules out one-bad-entry-drops-the-rest.
        hooks: {
          onAfterToolDispatch: () => {},
          onAppEvictSession: async (
            input: { sessionId: string },
            next: (i: { sessionId: string }) => Promise<void>,
          ) => {
            seen.push(`evict:${input.sessionId}`);
            await next(input);
          },
          onAppResumeSession: async (
            input: { sessionId: string },
            next: (i: { sessionId: string }) => Promise<SessionHarnessProtocol | undefined>,
          ) => {
            seen.push(`resume:${input.sessionId}`);
            return next(input);
          },
        },
      },
    });

    const s = await app.createSession({ sessionId: "wired", eager: true });
    await (
      await s.send({ messages: [{ role: "user", content: "first" }] })
    ).result;
    await app.evictSession("wired");
    expect(seen).toEqual(["evict:wired"]);
    expect(app.getSession("wired")).toBeUndefined();

    // The production flow: the wire send resolves the hibernated id through
    // findSessionOrResume → app.resumeSession (the OP) → hooks.
    const handler = sessionWireExtension.methods["session/send"]!;
    const result = (await handler(
      { sessionId: "wired", messages: [{ role: "user", content: "again" }] } as never,
      fakeWireCtx(gateway),
    )) as { executionId?: string };
    expect(result).toBeDefined();
    expect(seen).toContain("resume:wired");

    await gateway.close();
  });

  it("the idle SWEEP evicts under the live composition — telemetry + gateway door", async () => {
    // Live-regression rig (knowify 2026-08-23): on next.142 the sweep routes
    // through the evict OP; a deployment with telemetry configured stopped
    // evicting entirely while the op-less 141 sweep worked. Compose the same
    // shape: gateway door + telemetry runtime + idleTimeout sweep.
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new FakeLanguageModelExecutor("gw-sweep", journal, bus, inbox, {
      scripted: {
        result: {
          specVersion: SPEC_VERSION,
          output: [{ type: "text", text: "ok" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    });
    await executor.ready;
    const evicted: string[] = [];
    const gateway = new GatewayHarness({ journal, bus, inbox });
    await gateway.listen();
    const app = await gateway.createApp({
      appId: "sweep-live",
      rootElement: NULL_ROOT,
      options: {
        compiler: new CompilerHarness("r-sweep-live", journal, bus, inbox),
        modelExecutor: executor,
        target,
        journal,
        bus,
        inbox,
        telemetry: createTelemetry({ serviceName: "sweep-live" }),
        sessions: { idleTimeout: 40 },
        hooks: {
          onBeforeAppEvictSession: (input: { sessionId: string }) => {
            evicted.push(input.sessionId);
          },
        },
      },
    });
    await app.createSession({ sessionId: "sw1", eager: true });
    await waitFor(() => evicted.includes("sw1"), { timeoutMs: 3000, pollMs: 20 });
    expect(app.getSession("sw1")).toBeUndefined();
    await gateway.close();
  });
});
