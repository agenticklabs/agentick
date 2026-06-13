/**
 * LoopExecutorProtocol conformance suite invocation.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { runLoopExecutorConformance } from "@agentick/spec-conformance-next";

import { LoopExecutorHarness } from "../harness.js";

describe("LoopExecutorHarness — LoopExecutorProtocol conformance", () => {
  runLoopExecutorConformance(async ({ harnessId }) => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const loop = new LoopExecutorHarness(harnessId, journal, bus, inbox);
    await loop.ready;
    return loop;
  });
});
