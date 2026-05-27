/**
 * Substrate factory — wires journal + bus + inbox + harnesses.
 *
 * The Promise-typed harness surfaces (`ReconcilerProtocol`,
 * `ToolExecutorProtocol`) are what application code sees. Their bodies
 * run on the Effect substrate; FiberRef propagation, journaling, phase
 * contract, and idempotency are properties of `BaseHarness.runOperation`
 * — invisible at the surface.
 */

import React from "react";

import { MockLanguageModelExecutor } from "@agentick/executor";
import { LoopExecutorHarness, NoopStateApplicator } from "@agentick/loop-executor";
import { LocalChannelPublisher, LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ReconcilerHarness } from "@agentick/reconciler-react";
import { stubBridges } from "@agentick/reconciler";
import { SessionHarness } from "@agentick/session";
import type { HookBridges } from "@agentick/spec";
import { InMemoryHandlerResolver, ToolExecutorHarness } from "@agentick/tool-executor";

import { SupportAgent } from "./agent.js";
import { buildHandlerResolver } from "./tools.js";

export interface Substrate {
  readonly journal: MemoryJournal;
  readonly bus: LocalEventBus;
  readonly inbox: LocalInbox;
  readonly channels: LocalChannelPublisher;
  readonly reconciler: ReconcilerHarness;
  readonly tools: ToolExecutorHarness;
  readonly executor: MockLanguageModelExecutor;
  readonly loop: LoopExecutorHarness;
  readonly stateApplicator: NoopStateApplicator;
  readonly session: SessionHarness;
  readonly handlerResolver: InMemoryHandlerResolver;
  readonly bridges: HookBridges;
}

export async function buildSubstrate(sessionId: string): Promise<Substrate> {
  const journal = new MemoryJournal({ capacity: 10_000 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();

  // Channel publisher — routes tool ctx.emit() seeds through the bus
  // with monotonic per-channel sequence numbers. When the session
  // harness lands (Phase 4e), it implements ChannelPublisher itself
  // (per-session sequencing + retention + replay). Today's local
  // impl is the seam.
  const channels = new LocalChannelPublisher(bus, { defaultScope: { sessionId } });

  // Reconciler harness — owns mount/renderTree/renderToString for JSX
  // agent definitions. Scope id is its address suffix —
  // `reconciler:{scopeId}` on the inbox.
  const reconciler = new ReconcilerHarness("example", journal, bus, inbox);

  // Tool executor harness — owns the tool registry + dispatch.
  const handlerResolver = buildHandlerResolver();
  const tools = new ToolExecutorHarness("example", journal, bus, inbox, {
    handlerResolver,
    channelPublisher: channels,
  });

  // Executor harness — language-model invocation. The MockLanguageModelExecutor
  // returns a scripted reply (no real provider wire); real adapters
  // (OpenAI, Anthropic, etc.) implement the same ExecutorProtocol in
  // separate packages (Phase 4c).
  //
  // Scripted as a SEQUENCE so the loop-executor scenario can drive a
  // multi-tick agent loop:
  //   tick 1: model emits tool_use(calculator)
  //   tick 2: model emits final text given the tool result
  // The earlier executor-only scenario consumes only the first entry.
  const executor = new MockLanguageModelExecutor("example", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [
            {
              type: "tool_use",
              toolUseId: "tc-loop-calc",
              name: "calculator",
              input: { expression: "47 * 23" },
            },
          ],
          stopReason: "tool_use",
          toolCalls: [
            {
              id: "tc-loop-calc",
              name: "calculator",
              input: { expression: "47 * 23" },
            },
          ],
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        },
        stream: [
          { kind: "content_delta", delta: "47" },
          { kind: "content_delta", delta: " × " },
          { kind: "content_delta", delta: "23 " },
          { kind: "content_delta", delta: "= " },
          { kind: "content_delta", delta: "1081." },
        ],
      },
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "47 × 23 = 1081." }],
          stopReason: "end",
          usage: { inputTokens: 18, outputTokens: 10, totalTokens: 28 },
        },
      },
    ],
  });

  // Loop executor harness — orchestration: render → executor.run →
  // tool dispatch → state apply → continuation → repeat (bounded by
  // maxTicks). Wires the reconciler / executor / tool-executor
  // harnesses into the canonical agent loop.
  const loop = new LoopExecutorHarness("example", journal, bus, inbox);

  // State applicator — placeholder until the session harness (Phase 4e)
  // implements timeline writes. With Noop, multi-tick re-renders won't
  // see the prior tick's tool results in the timeline; the loop demo
  // works around this by relying on the executor's scripted sequence
  // (the mock just returns the next pre-canned response regardless of
  // what was applied).
  const stateApplicator = new NoopStateApplicator();

  // Session-scoped executor — independent scripted sequence so the
  // session.send() demo isn't drained by the earlier loop scenario.
  const sessionExecutor = new MockLanguageModelExecutor("session-example", journal, bus, inbox, {
    scripted: [
      {
        result: {
          specVersion: "2026-05-08",
          output: [
            {
              type: "tool_use",
              toolUseId: "tc-session-calc",
              name: "calculator",
              input: { expression: "47 * 23" },
            },
          ],
          stopReason: "tool_use",
          toolCalls: [
            {
              id: "tc-session-calc",
              name: "calculator",
              input: { expression: "47 * 23" },
            },
          ],
          usage: { inputTokens: 15, outputTokens: 8, totalTokens: 23 },
        },
        stream: [
          { kind: "content_delta", delta: "Let me compute that — " },
          { kind: "content_delta", delta: "calling calculator." },
        ],
      },
      {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "47 × 23 = 1081." }],
          stopReason: "end",
          usage: { inputTokens: 22, outputTokens: 9, totalTokens: 31 },
        },
      },
    ],
  });

  // Session harness — the integration site. Mounts the SupportAgent
  // into its own mountId inside the shared reconciler, provides
  // HookBridges backed by full harnesses (TimelineHarness for the
  // log + projection; KnobsHarness + StateHarness for reactive state),
  // and exposes `session.send({ messages })` as the user-facing
  // entry point.
  const session = new SessionHarness(journal, bus, inbox, {
    sessionId,
    agent: React.createElement(SupportAgent),
    reconciler,
    loop,
    executor: sessionExecutor,
    toolExecutor: tools,
    target: {
      kind: "language-model",
      provider: "mock",
      modelId: "mock-v1",
      capabilities: { supportsTools: true, supportsStreaming: true },
    },
    defaultMaxTicks: 4,
  });

  // Wait for all harnesses to finish their inbox registrations + the
  // session's own mount to settle.
  await Promise.all([
    reconciler.ready,
    tools.ready,
    executor.ready,
    sessionExecutor.ready,
    loop.ready,
    session.ready,
  ]);
  await session.mountReady;

  // Stub bridges for the standalone reconciler scenarios — in-memory
  // data cache + stub knobs/state/timeline harnesses + session
  // metadata. The session harness provides its OWN bridges to the
  // reconciler at mount time; these bridges are only used by the
  // earlier example scenarios that mount a separate JSX tree under
  // `MOUNT_ID`.
  const bridges = stubBridges({ sessionId });

  return {
    journal,
    bus,
    inbox,
    channels,
    reconciler,
    tools,
    executor,
    loop,
    stateApplicator,
    session,
    handlerResolver,
    bridges,
  };
}
