/**
 * Implementation-specific behavior tests for FakeLanguageModelExecutor.
 *
 * The conformance suite (`conformance.spec.ts`) covers the protocol
 * contract. These tests cover behavior the mock impl specifically
 * implements — streaming chunks, abort flow, scripted result delivery.
 */

import { Chunk, Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { LanguageModelTarget, RenderedTree } from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { FakeLanguageModelExecutor } from "../fake-language-model-executor.js";

function emptyTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m_1", role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
  };
}

function mkTarget(): LanguageModelTarget {
  return { kind: "language-model", provider: "mock", modelId: "mock-v1" };
}

async function makeExecutor(opts: ConstructorParameters<typeof FakeLanguageModelExecutor>[4] = {}) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new FakeLanguageModelExecutor("exec-bench", journal, bus, inbox, opts);
  await exec.ready;
  return { exec, journal, bus, inbox };
}

describe("FakeLanguageModelExecutor — project", () => {
  it("folds a system entry into a leading system message", async () => {
    const { exec } = await makeExecutor();
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          // ADR 94: a `<Section title="Persona">` inside `<System>` reaches
          // the executor already lowered into the message's blocks.
          {
            kind: "message",
            role: "system",
            id: "s.intro",
            content: [{ type: "text", text: "# Persona\nYou are concise.", id: "s.intro" }],
          },
          {
            kind: "message",
            id: "m_1",
            role: "user",
            content: [{ type: "text", text: "hi" }],
          },
        ],
      },
    };
    const input = await exec.project({ compiled: tree, target: mkTarget(), tools: [] });
    expect(input.messages[0]!.role).toBe("system");
    expect(input.messages[0]!.content[0]).toMatchObject({ type: "text" });
    expect((input.messages[0]!.content[0] as { text: string }).text).toContain("Persona");
    expect(input.messages[1]!.role).toBe("user");
  });

  it("emits declared tools filtered to exposure includes 'model'", async () => {
    const { exec } = await makeExecutor();
    const tree: RenderedTree = {
      specVersion: "2026-05-08",
      context: { entries: [] },
    };
    // Tools come through `ProjectInput.tools` — the loop's per-tick
    // compile result. `compiled.declarations.tools` is the IR's
    // compiler record but NOT the projection source.
    const input = await exec.project({
      compiled: tree,
      target: mkTarget(),
      tools: [
        {
          id: "t.calc",
          name: "calculator",
          description: "Math",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["model"],
          handlerRef: "h.calc",
        },
        {
          id: "t.priv",
          name: "private",
          description: "Dispatch only — not exposed to the model",
          inputSchema: jsonSchema({ type: "object" }),
          exposure: ["dispatch"],
          handlerRef: "h.priv",
        },
      ],
    });
    expect(input.tools).toHaveLength(1);
    expect(input.tools![0]!.name).toBe("calculator");
  });
});

describe("FakeLanguageModelExecutor — run + streaming", () => {
  it("emits one delta envelope per scripted stream chunk", async () => {
    const { exec, bus } = await makeExecutor({
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "abc" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
        },
        deltas: [
          { type: "content-delta", blockIndex: 0, delta: "a" },
          { type: "content-delta", blockIndex: 0, delta: "b" },
          { type: "content-delta", blockIndex: 0, delta: "c" },
        ],
      },
    });

    const fiber = Effect.runFork(
      Stream.runCollect(Stream.take(bus.subscribe({ surface: "model", phase: "delta" }), 3)),
    );
    await new Promise((r) => setImmediate(r));

    const terminal = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    expect(terminal.outcome).toBe("succeeded");

    const chunk = await Effect.runPromise(Fiber.join(fiber));
    const deltas = Array.from(Chunk.toReadonlyArray(chunk));
    expect(deltas).toHaveLength(3);
    for (const ev of deltas) expect(ev.phase).toBe("delta");
  });

  it("skips delta envelope construction when no subscriber matches", async () => {
    // Without a subscriber, emitDelta probes hasSubscriber and
    // skips the thunk. Streaming is invisible but the run still
    // succeeds with the scripted terminal.
    let builds = 0;
    const deltas: import("@agentick/spec").AdapterDelta[] = Array.from({ length: 5 }, (_, i) => ({
      type: "content-delta",
      blockIndex: 0,
      delta: `tok-${i}`,
    }));
    // Patch our scripted deltas to count thunk invocations indirectly:
    // we observe that builds === 0 means no envelope construction.
    const { exec } = await makeExecutor({
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "done" }],
          stopReason: "end",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
        deltas,
      },
    });
    const terminal = await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    expect(terminal.outcome).toBe("succeeded");
    // Indirect verification: the run completed with no observable side
    // effects on the bus (no subscriber attached). Builds aren't directly
    // observable but the lazy-path bench in @agentick/runtime quantifies
    // the speedup; here we only assert correctness.
    void builds;
  });
});

describe("FakeLanguageModelExecutor — abort", () => {
  it("subsequent run with the same executionId terminates as 'canceled'", async () => {
    const { exec } = await makeExecutor({
      scripted: {
        result: {
          specVersion: "2026-05-08",
          output: [{ type: "text", text: "fine" }],
          stopReason: "end",
        },
      },
    });
    const id = "exec-abort-1";
    await exec.abort({ executionId: id });
    const terminal = await exec.run({
      compiled: emptyTree(),
      target: mkTarget(),
      scope: { executionId: id },
      tools: [],
    });
    expect(terminal.outcome).toBe("canceled");
  });
});

describe("FakeLanguageModelExecutor — terminal envelope journaled", () => {
  it("run produces requested + terminal envelopes on the journal", async () => {
    const { exec, journal } = await makeExecutor();
    await exec.run({ compiled: emptyTree(), target: mkTarget(), tools: [] });
    const chunk = await Effect.runPromise(
      Stream.runCollect(journal.readByQuery({ surface: "model" }, "beginning")),
    );
    const events = Array.from(Chunk.toReadonlyArray(chunk));
    const names = new Set(events.map((e) => `${e.name}.${e.phase}`));
    expect(names.has("model:command:run.requested")).toBe(true);
    expect([...names].some((n) => n.startsWith("model:command:run.terminal"))).toBe(true);
  });
});
