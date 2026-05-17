/**
 * Substrate factory — wires journal + bus + inbox + harnesses.
 *
 * The Promise-typed harness surfaces (`ReconcilerProtocol`,
 * `ToolExecutorProtocol`) are what application code sees. Their bodies
 * run on the Effect substrate; FiberRef propagation, journaling, phase
 * contract, and idempotency are properties of `BaseHarness.runOperation`
 * — invisible at the surface.
 */

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

  // Wait for both harnesses to finish their inbox registrations.
  await Promise.all([reconciler.ready, tools.ready]);

  // Stub bridges for the reconciler — in-memory data cache, knob store,
  // session metadata. A real session harness (Phase 4e) will supply
  // backed bridges that route timeline reads to the persisted log.
  const bridges = stubBridges({ sessionId });

  return { journal, bus, inbox, channels, reconciler, tools, handlerResolver, bridges };
}
