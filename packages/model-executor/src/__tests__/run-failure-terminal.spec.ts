/**
 * `run()` answers in TERMINALS, including for failure (ADR 99).
 *
 * The streaming path already produced a `failed` terminal (the loop's
 * `streamTerminal`), while `run` — the `stream: false` path — rejected. A
 * rejection never reaches the decide fold, so a deployment that turns streaming
 * off got no tick retry at all, for any failure class.
 *
 * Projection and normalization defects fold too. They once stayed rejections on
 * the theory that a retry would reproduce them — but a rejection reaches only
 * the promise's awaiter, and the turn boundary recorded `failed` with no cause.
 * The decide fold already defaults to stop; not retrying is its call to make.
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

describe("run() folds local defects to a failed terminal that names the phase", () => {
  // A rejection carries the cause to exactly one reader: whoever awaits the
  // promise. A failed terminal carries it to the tick result, the stop cause,
  // and the turn boundary — the record a deployment actually reads back when a
  // turn "failed for no reason". Whether a retry would reproduce the defect is
  // the decide fold's call (ADR 99), and its default is to stop.
  it("a normalization defect", async () => {
    const exec = await makeExecutor("run-fold-normalize", {
      normalizeThrows: new Error("cannot read property 'candidates' of undefined"),
    });
    const terminal = await exec.run(mkInput());
    expect(terminal.outcome).toBe("failed");
    if (terminal.outcome !== "failed") throw new Error("expected a failed terminal");
    expect(terminal.error._tag).toBe("NormalizationFailed");
    expect(terminal.error.message).toContain("candidates");
  });

  it("a projection defect", async () => {
    const exec = await makeExecutor("run-fold-project", {
      projectThrows: new Error("projection blew up"),
    });
    const terminal = await exec.run(mkInput());
    expect(terminal.outcome).toBe("failed");
    if (terminal.outcome !== "failed") throw new Error("expected a failed terminal");
    expect(terminal.error._tag).toBe("ProjectionFailed");
    expect(terminal.error.message).toContain("projection blew up");
  });
});
