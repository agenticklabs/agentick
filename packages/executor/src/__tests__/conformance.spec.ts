/**
 * Conformance suite invocation for `MockLanguageModelExecutor`.
 *
 * Drives the spec-defined contract through this package's reference
 * implementation. Future provider adapters (`@agentick/executor-openai`,
 * etc.) wire the same suite against their concrete impl.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runExecutorConformance } from "@agentick/spec-conformance";

import { MockLanguageModelExecutor } from "../mock-language-model-executor.js";

describe("MockLanguageModelExecutor — ExecutorProtocol conformance", () =>
  runExecutorConformance(async ({ harnessId, scripted }) => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new MockLanguageModelExecutor(
      harnessId,
      journal,
      bus,
      inbox,
      scripted !== undefined ? { scripted: { result: scripted } } : {},
    );
    await exec.ready;
    return exec;
  }));
