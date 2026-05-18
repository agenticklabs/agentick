/**
 * Substrate factory — wires journal + bus + inbox + harnesses.
 *
 * The Promise-typed harness surfaces (`ReconcilerProtocol`,
 * `ToolExecutorProtocol`) are what application code sees. Their bodies
 * run on the Effect substrate; FiberRef propagation, journaling, phase
 * contract, and idempotency are properties of `BaseHarness.runOperation`
 * — invisible at the surface.
 */

import { MockLanguageModelExecutor } from "@agentick/executor";
import {
  LoopExecutorHarness,
  NoopStateApplicator,
} from "@agentick/loop-executor";
import {
  LocalChannelPublisher,
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
} from "@agentick/runtime";
import { ReconcilerHarness, stubBridges } from "@agentick/reconciler-react";
import type { HookBridges } from "@agentick/spec";
import {
  InMemoryHandlerResolver,
  ToolExecutorHarness,
} from "@agentick/tool-executor";

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
  const executor = new MockLanguageModelExecutor(
    "example",
    journal,
    bus,
    inbox,
    {
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
    },
  );

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

  // Wait for all harnesses to finish their inbox registrations.
  await Promise.all([reconciler.ready, tools.ready, executor.ready, loop.ready]);

  // Stub bridges for the reconciler — in-memory data cache, knob store,
  // session metadata. A real session harness (Phase 4e) will supply
  // backed bridges that route timeline reads to the persisted log.
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
    handlerResolver,
    bridges,
  };
}
