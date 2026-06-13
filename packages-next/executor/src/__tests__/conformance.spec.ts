/**
 * Conformance suite invocation for `FakeLanguageModelExecutor`.
 *
 * Drives the spec-defined contract through this package's reference
 * implementation. Future provider adapters (`@agentick/executor-openai-next`,
 * etc.) wire the same suite against their concrete impl.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { runExecutorConformance } from "@agentick/spec-conformance-next";

import { FakeLanguageModelExecutor } from "../fake-language-model-executor.js";

describe("FakeLanguageModelExecutor — ExecutorProtocol conformance", () => {
  runExecutorConformance(async ({ harnessId, scripted }) => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new FakeLanguageModelExecutor(
      harnessId,
      journal,
      bus,
      inbox,
      scripted !== undefined ? { scripted: { result: scripted } } : {},
    );
    await exec.ready;
    return { executor: exec, bus };
  });
});
