/**
 * Executor command-lifecycle hooks (ADR 80/83). The model-path verbs
 * (`executor:project`, `executor:execute`, plus `run` / `normalize`) route
 * through `runOperation`, so the `CommandRegistry` augmentation in
 * `language-model-executor.ts` mints typed `onBefore/After<Verb>` hooks. These
 * tests prove the DIRECT facades fire their hooks:
 *
 *   - `onBeforeExecutorProject` fires when `project()` is called.
 *   - `onBeforeExecutorExecute` fires when `execute()` is called.
 *
 * The loop's hot path (`fx.run` → `runBody`) inlines project/execute beneath
 * the single `executor:run` op, so those sub-op hooks do NOT re-fire per tick
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
} from "@agentick/spec-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { LanguageModelExecutor } from "../language-model-executor.js";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model-next";

interface StubRaw {
  readonly text: string;
}

const TARGET: ExecutionTarget = { kind: "language-model", provider: "stub", modelId: "stub-v1" };

function stubAdapter(): LanguageModelAdapter<StubRaw, never> {
  return {
    provider: "stub",
    target: TARGET,
    streamByDefault: false,
    buildParams(): unknown {
      return {};
    },
    call(): Promise<StubRaw> {
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
  it("onBeforeExecutorProject fires when project() is called", async () => {
    const exec = await makeExecutor();
    let fired = 0;
    let seen: unknown;
    const off = exec.hook({
      onBeforeExecutorProject: (input) => {
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

  it("onBeforeExecutorExecute fires when execute() is called", async () => {
    const exec = await makeExecutor();
    let fired = 0;
    const off = exec.hooks.onBeforeExecutorExecute(() => {
      fired += 1;
    });

    const projected = await exec.project(projectInput());
    await exec.execute(executeInput(projected));

    expect(fired).toBe(1);

    off();
    await exec.close();
  });

  it("onAfterExecutorProject sees the projected LanguageModelInput output", async () => {
    const exec = await makeExecutor();
    let seenOutput: unknown;
    const off = exec.hook({
      onAfterExecutorProject: (output) => {
        seenOutput = output;
      },
    });

    await exec.project(projectInput());

    expect(seenOutput).toBeDefined();

    off();
    await exec.close();
  });
});
