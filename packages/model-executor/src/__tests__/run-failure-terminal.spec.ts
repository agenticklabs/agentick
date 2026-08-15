/**
 * `run()` answers in TERMINALS, including for failure (ADR 99).
 *
 * The streaming path already produced a `failed` terminal (the loop's
 * `streamTerminal`), while `run` — the `stream: false` path — rejected. A
 * rejection never reaches the decide fold, so a deployment that turns streaming
 * off got no tick retry at all, for any failure class.
 *
 * What does NOT fold: a projection or normalization defect. Those reproduce
 * exactly on a re-issued request, so they stay rejections rather than becoming
 * terminals a policy could waste a tick on.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import { describe, expect, it } from "vitest";

import type {
  AdapterDelta,
  ExecuteInput,
  LanguageModelExecutionResult,
  LanguageModelInput,
  RenderedTree,
  RunInput,
} from "@agentick/spec";
import { MalformedModelOutput, SPEC_VERSION } from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";

import { LanguageModelExecutor } from "../language-model-executor.js";

interface StubRaw {
  readonly text: string;
}

interface StubBehavior {
  readonly sendThrows?: unknown;
  readonly normalizeThrows?: unknown;
  readonly projectThrows?: unknown;
}

function stubAdapter(behavior: StubBehavior): LanguageModelAdapter<StubRaw, never> {
  return {
    provider: "stub",
    target: { kind: "language-model", provider: "stub", modelId: "stub-v1" },
    streamByDefault: false,
    project() {
      if (behavior.projectThrows !== undefined) throw behavior.projectThrows;
      return { messages: [] };
    },
    prepareRequest(_input: ExecuteInput<LanguageModelInput>): unknown {
      return {};
    },
    send(): Promise<StubRaw> {
      return behavior.sendThrows !== undefined
        ? Promise.reject(behavior.sendThrows)
        : Promise.resolve({ text: "ok" });
    },
    mapChunk(): readonly AdapterDelta[] {
      return [];
    },
    reconstructRaw(_accum: StreamAccumulatorView): StubRaw {
      return { text: "ok" };
    },
    normalize(raw: StubRaw): LanguageModelExecutionResult {
      if (behavior.normalizeThrows !== undefined) throw behavior.normalizeThrows;
      return {
        specVersion: SPEC_VERSION,
        output: [{ type: "text", text: raw.text }],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  };
}

async function makeExecutor(
  scope: string,
  behavior: StubBehavior,
): Promise<LanguageModelExecutor<StubRaw, never>> {
  const exec = new LanguageModelExecutor<StubRaw, never>(
    scope,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter: stubAdapter(behavior) },
  );
  await exec.ready;
  return exec;
}

const mkInput = (): RunInput => ({
  compiled: { specVersion: SPEC_VERSION, context: { entries: [] } } as RenderedTree,
  target: { kind: "language-model", provider: "stub", modelId: "stub-v1" },
  tools: [],
});

describe("run() folds a classified provider failure into a failed terminal", () => {
  it("keeps the class the adapter named — the distinction a retry policy reads", async () => {
    const exec = await makeExecutor("run-fold-malformed", {
      sendThrows: new MalformedModelOutput({ toolName: "q", rawArguments: '{"a' }),
    });
    const terminal = await exec.run(mkInput());
    expect(terminal).toMatchObject({
      outcome: "failed",
      error: { _tag: "MalformedModelOutput", toolName: "q" },
    });
  });

  it("folds an unclassified provider error under the default table's class", async () => {
    const exec = await makeExecutor("run-fold-stream", { sendThrows: new Error("socket hang up") });
    const terminal = await exec.run(mkInput());
    expect(terminal).toMatchObject({ outcome: "failed", error: { _tag: "StreamFailed" } });
  });

  it("folds a classified failure raised at NORMALIZE too", async () => {
    // Gemini's malformed-function-call arrives this way: a response the provider
    // accepted, which the adapter refuses at normalize.
    const exec = await makeExecutor("run-fold-normalize", {
      normalizeThrows: new MalformedModelOutput({}),
    });
    const terminal = await exec.run(mkInput());
    expect(terminal).toMatchObject({
      outcome: "failed",
      error: { _tag: "MalformedModelOutput" },
    });
  });

  it("an abort is still a CANCELED terminal, not a failed one", async () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    const exec = await makeExecutor("run-fold-abort", { sendThrows: aborted });
    const terminal = await exec.run(mkInput());
    expect(terminal.outcome).toBe("canceled");
  });
});

describe("run() keeps rejecting for deterministic local failures", () => {
  it("a normalization defect rejects — a retry would reproduce it exactly", async () => {
    const exec = await makeExecutor("run-reject-normalize", {
      normalizeThrows: new Error("cannot read property 'candidates' of undefined"),
    });
    await expect(exec.run(mkInput())).rejects.toMatchObject({ _tag: "NormalizationFailed" });
  });

  it("a projection failure never becomes a terminal", async () => {
    const exec = await makeExecutor("run-reject-project", {
      projectThrows: new Error("projection blew up"),
    });
    await expect(exec.run(mkInput())).rejects.toBeTruthy();
  });
});
