/**
 * LoopExecutorProtocol conformance suite invocation.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runLoopExecutorConformance } from "@agentick/spec-conformance";

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
