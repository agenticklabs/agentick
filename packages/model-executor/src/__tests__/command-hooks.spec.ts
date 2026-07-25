/**
 * Executor command-lifecycle hooks (ADR 80/83/89). The model-path verbs
 * (`model:project`, `model:generate`, plus `run` / `normalize`) route through
 * the command cascade / `runOperation`, so the `CommandRegistry` augmentation in
 * `language-model-executor.ts` mints typed `onBefore/After<Verb>` hooks. These
 * tests prove the DIRECT facades fire their hooks:
 *
 *   - `onBeforeModelProject` fires when `project()` is called.
 *   - `onBeforeModelGenerate` fires when `execute()` is called (the model call
 *     is now the `model:generate` command).
 *
 * The loop's hot path (`fx.run` → `runBody`) inlines project/generate beneath
 * the single `model:run` op, so those sub-op hooks do NOT re-fire per tick
 * (by design) — hence the direct-facade drive here.
 */

import { describe, expect, it } from "vitest";

import type {
  AdapterDelta,
  ExecuteInput,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  ProjectInput,
  RenderedTree,
} from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { LanguageModelExecutor } from "../language-model-executor.js";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";

interface StubRaw {
  readonly text: string;
}

const TARGET: ExecutionTarget = { kind: "language-model", provider: "stub", modelId: "stub-v1" };

function stubAdapter(): LanguageModelAdapter<StubRaw, never> {
  return {
    provider: "stub",
    target: TARGET,
    streamByDefault: false,
    prepareRequest(): unknown {
      return {};
    },
    send(): Promise<StubRaw> {
      return Promise.resolve({ text: "ok" });
    },
    async *openStream(): AsyncIterable<never> {},
    mapChunk(): readonly AdapterDelta[] {
      return [];
    },
    reconstructRaw(_accum: StreamAccumulatorView): StubRaw {
      return { text: "ok" };
    },
    normalize(raw: StubRaw): LanguageModelExecutionResult {
      return {
        specVersion: "2026-05-08",
        output: [{ type: "text", text: raw.text }],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  };
}

async function makeExecutor(): Promise<LanguageModelExecutor<StubRaw, never>> {
  const exec = new LanguageModelExecutor<StubRaw, never>(
    "exec-hooks",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter: stubAdapter() },
  );
  await exec.ready;
  return exec;
}

const emptyTree = (): RenderedTree => ({ specVersion: "2026-05-08", context: { entries: [] } });
const projectInput = (): ProjectInput => ({ compiled: emptyTree(), target: TARGET, tools: [] });
const executeInput = (targetInput: LanguageModelInput): ExecuteInput<LanguageModelInput> => ({
  targetInput,
  target: TARGET,
});

describe("LanguageModelExecutor — command-lifecycle hooks (ADR 83)", () => {
  it("onBeforeModelProject fires when project() is called", async () => {
    const exec = await makeExecutor();
    let fired = 0;
    let seen: unknown;
    const off = exec.hook({
      onBeforeModelProject: (input) => {
        fired += 1;
        seen = input;
      },
    });

    const projected = await exec.project(projectInput());

    expect(fired).toBe(1);
    expect(seen).toMatchObject({ target: { modelId: "stub-v1" } });
    expect(projected).toBeDefined();

    off();
    await exec.close();
  });

  it("onBeforeModelGenerate fires when execute() is called", async () => {
    const exec = await makeExecutor();
    let fired = 0;
    const off = exec.hooks.onBeforeModelGenerate(() => {
      fired += 1;
    });

    const projected = await exec.project(projectInput());
    await exec.execute(executeInput(projected));

    expect(fired).toBe(1);

    off();
    await exec.close();
  });

  it("onAfterModelProject sees the projected LanguageModelInput output", async () => {
    const exec = await makeExecutor();
    let seenOutput: unknown;
    const off = exec.hook({
      onAfterModelProject: (output) => {
        seenOutput = output;
      },
    });

    await exec.project(projectInput());

    expect(seenOutput).toBeDefined();

    off();
    await exec.close();
  });
});
