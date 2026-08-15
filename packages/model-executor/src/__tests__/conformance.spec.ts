/**
 * Conformance suite invocation for `FakeLanguageModelExecutor`.
 *
 * Drives the spec-defined contract through this package's reference
 * implementation. Future provider adapters (`@agentick/model-openai`,
 * etc.) wire the same suite against their concrete impl.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runExecutorConformance } from "@agentick/spec-conformance";

import { FakeLanguageModelExecutor } from "../fake-language-model-executor.js";

describe("FakeLanguageModelExecutor — ExecutorProtocol conformance", () => {
  runExecutorConformance(
    async ({ harnessId, scripted }) => {
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
    },
    // The fake has no provider client to throw from and no classification step:
    // it takes its failure class straight from the script (`scripted.error`).
    // The default table is certified against the REAL executor in
    // `language-model-executor-conformance.spec.ts`.
    {
      ProviderRejected: "not-applicable",
      ProviderTimeout: "not-applicable",
      ProviderAborted: "not-applicable",
      StreamFailed: "not-applicable",
      MalformedModelOutput: "not-applicable",
    },
  );
});
