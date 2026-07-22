/**
 * A2.5 — PREFIX-STABILITY conformance (the prompt-cache invariant).
 *
 * Provider prompt caches key on an EXACT prefix match: any drift in the
 * cached prefix silently busts the cache and re-bills the full prompt.
 * The compiler's output _is_ the model input, so its byte-stability
 * across ticks is a cache correctness property, not a nicety. This suite
 * pins it end-to-end against the REAL React compiler + the canonical
 * projection (`@agentick/model-next`'s `defaultProject`) + a real loop
 * run — app-next is the only home where all three coexist (the ADR-27
 * modularity rule: cross-harness integration tests live where their
 * dependencies live).
 *
 * The invariant, in three parts:
 *
 *   1. A STATIC tree (no state change between renders) compiles to a
 *      BYTE-IDENTICAL `RenderedTree` and BYTE-IDENTICAL model input on
 *      every render of one mount. No exclusions — within a mount, host
 *      ids are stable, so nothing legitimately varies.
 *
 *   2. Across SEPARATE mounts the model-facing bytes stay identical even
 *      though the `RenderedTree`'s auto-generated element ids differ. The
 *      id field is the ONE legitimately-varying field (per-process host
 *      counter — see the exclusion justification on that test) and it is
 *      excluded from the model projection by construction, which is
 *      exactly why the cache stays warm across processes.
 *
 *   3. A real loop run produces a PREFIX-APPEND-ONLY compiled prefix: the
 *      system message + prior conversation messages are byte-identical
 *      between tick N and N+1, and later ticks only APPEND new entries.
 *      This is the actual provider-cache property.
 *
 * Plus the load-bearing default: the framework injects NO time-varying
 * content (no timestamp/date/clock) into the stable prefix. That default
 * is asserted here so a future regression that "helpfully" stamps a date
 * into the system prompt fails loudly.
 *
 * @see packages-next/compiler/README.md §"Prompt-cache stability"
 * @see docs/proposals/v2/STATUS.md — ROADMAP A2.5
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { CompilerHarness } from "@agentick/compiler-react-next";
import { System, H2, Paragraph } from "@agentick/compiler-react-next";
import { fakeBridges } from "@agentick/compiler-next";
import { FakeLanguageModelExecutor } from "@agentick/model-executor-next";
import { defaultProject } from "@agentick/model-next";
import type {
  ContentBlock,
  ExecutionTarget,
  ExecutorFx,
  LanguageModelExecutionResult,
  LanguageModelInput,
  ProjectInput,
  RenderedTree,
  RunInput,
  ToolHandler,
} from "@agentick/spec-next";
import { jsonSchema } from "@agentick/spec-next";

import { createApp } from "../react.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A representative STATIC agent: a system message, two sections (one with
 * an explicit id + semantic children, one with an auto-derived id), and
 * two tools with JSON schemas (one explicit id, one auto). No embedded
 * user message and no time-varying content — the whole tree is a stable
 * cache prefix. The auto-id section/tool deliberately exercise the
 * `stableId` → `hostId` path so the separate-mount exclusion is real.
 */
function RepresentativeAgent(): React.ReactElement {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(System, null, "You are a helpful assistant."),
    // Explicit-id section with semantic children (heading + paragraph).
    React.createElement(
      "section" as never,
      { id: "guidelines", title: "Guidelines", audience: "model" },
      React.createElement(H2, null, "House rules"),
      React.createElement(Paragraph, null, "Be concise. Cite your sources."),
    ),
    // Auto-id section (no `id` prop → id defaults from ctx.stableId/hostId).
    React.createElement("section" as never, { title: "Notes" }, "Static reference notes."),
    // Explicit-id tool with an input schema.
    React.createElement("tool" as never, {
      id: "t.search",
      name: "search",
      description: "Search the corpus",
      inputSchema: jsonSchema({
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, limit: { type: "number" } },
      }),
      exposure: ["model"],
      handlerRef: "handlers/search",
    }),
    // Auto-id tool (no `id` prop → id defaults from ctx.stableId/hostId).
    React.createElement("tool" as never, {
      name: "noop",
      description: "Does nothing",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      exposure: ["model"],
      handlerRef: "handlers/noop",
    }),
  );
}

function mkTarget(): ExecutionTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}

/** Build a canonical `ProjectInput` from a compiled tree. */
function toProjectInput(tree: RenderedTree): ProjectInput {
  return { compiled: tree, target: mkTarget(), tools: tree.declarations?.tools ?? [] };
}

async function makeCompiler(): Promise<CompilerHarness> {
  const harness = new CompilerHarness(
    "prefix-stability",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

async function mount(harness: CompilerHarness, mountId: string): Promise<void> {
  await harness.mount({
    mountId,
    sessionId: "s",
    element: React.createElement(RepresentativeAgent),
    bridges: fakeBridges({ sessionId: "s" }),
    defaultFormatter: { id: "markdown", format: "markdown" },
  });
}

/**
 * Deep-clone a tree with every context-entry `id` and tool-declaration
 * `id` removed. Isolates the ONLY field that can differ across separate
 * mounts (auto-generated `hostId`-derived ids) so the remainder can be
 * asserted byte-identical.
 */
function stripIds(tree: RenderedTree): unknown {
  const clone = JSON.parse(JSON.stringify(tree)) as {
    context?: { entries?: Array<Record<string, unknown>> };
    declarations?: { tools?: Array<Record<string, unknown>> };
  };
  for (const e of clone.context?.entries ?? []) delete e.id;
  for (const t of clone.declarations?.tools ?? []) delete t.id;
  return clone;
}

/** The auto-id "Notes" section's id — the concrete `hostId`-derived value. */
function notesSectionId(tree: RenderedTree): string | undefined {
  const e = tree.context.entries.find((x) => x.kind === "section" && x.title === "Notes");
  return e?.kind === "section" ? e.id : undefined;
}

/**
 * A `FakeLanguageModelExecutor` that records the `ProjectInput` the loop
 * hands its projection each tick. The default (streaming) loop path calls
 * `fx.project`; the non-streaming path routes through `fx.run`. Recording
 * BOTH captures whichever fires — exactly once per tick — so the test is
 * robust to the streaming default without forcing a path.
 */
class RecordingExecutor extends FakeLanguageModelExecutor {
  readonly captured: ProjectInput[] = [];

  override get fx(): ExecutorFx<LanguageModelInput, unknown, LanguageModelExecutionResult> {
    const base = super.fx;
    const captured = this.captured;
    const grab = (input: ProjectInput | RunInput): void => {
      captured.push({
        compiled: input.compiled,
        target: input.target,
        tools: input.tools,
        ...(input.providerTools !== undefined ? { providerTools: input.providerTools } : {}),
        ...(input.narrate !== undefined ? { narrate: input.narrate } : {}),
      });
    };
    return {
      ...base,
      project: (input) => {
        grab(input);
        return base.project(input);
      },
      run: (input) => {
        grab(input);
        return base.run(input);
      },
    };
  }
}

// A regex matching an ISO-8601-ish date or a wall-clock time. If any
// framework default leaks a timestamp into the stable prefix, this fires.
const TIME_VARYING = /\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}(:\d{2})?\b/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("A2.5 — prefix-cache stability (the prompt-cache invariant)", () => {
  it("static tree → byte-identical RenderedTree AND model input across N renders of one mount", async () => {
    const harness = await makeCompiler();
    await mount(harness, "m");

    const trees: RenderedTree[] = [];
    for (let i = 0; i < 3; i++) {
      const { tree, diagnostics } = await harness.renderTree({ mountId: "m", sessionId: "s" });
      expect(diagnostics).toEqual([]);
      trees.push(tree);
    }

    // RenderedTree: deep-equal AND byte-identical, with NO exclusions —
    // within one mount host ids are stable, so nothing legitimately varies.
    const irBaseline = JSON.stringify(trees[0]);
    for (const tree of trees) {
      expect(tree).toEqual(trees[0]);
      expect(JSON.stringify(tree)).toBe(irBaseline);
    }

    // Model-facing bytes: byte-identical `JSON.stringify(defaultProject(...))`.
    const modelBaseline = JSON.stringify(defaultProject(toProjectInput(trees[0]!)));
    for (const tree of trees) {
      expect(JSON.stringify(defaultProject(toProjectInput(tree)))).toBe(modelBaseline);
    }

    await harness.unmount({ mountId: "m" });
  });

  it("separate mounts: model input is byte-identical though auto-generated RenderedTree ids differ", async () => {
    // EXCLUSION JUSTIFICATION: `hostId` is a per-process monotonic counter
    // (`compiler/src/host/host-instance.ts`), stable across a mount's
    // re-renders but NOT across separate mounts. `ctx.stableId` derives
    // auto element ids from it, so the two trees' auto-id fields
    // (`Notes` section, `noop` tool) legitimately differ. This is NOT a
    // cache-busting defect: those ids are internal identity and are NOT
    // projected into the model input — `buildMessages` emits section
    // title+text, `buildTools` emits tool NAME+schema, neither reads `id`.
    // The model-facing bytes are therefore mount-independent, which is
    // precisely the property that keeps a provider cache warm across
    // processes/replicas.
    const harness = await makeCompiler();
    await mount(harness, "a");
    await mount(harness, "b"); // counter advances between mounts → distinct hostIds

    const ta = (await harness.renderTree({ mountId: "a", sessionId: "s" })).tree;
    const tb = (await harness.renderTree({ mountId: "b", sessionId: "s" })).tree;

    // The finding is real: auto-generated ids DO differ across mounts.
    const idA = notesSectionId(ta);
    const idB = notesSectionId(tb);
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);

    // The RenderedTrees differ ONLY in those ids — everything else identical.
    expect(JSON.stringify(stripIds(ta))).toBe(JSON.stringify(stripIds(tb)));

    // The model-facing bytes — the actual provider cache key — are identical.
    expect(JSON.stringify(defaultProject(toProjectInput(ta)))).toBe(
      JSON.stringify(defaultProject(toProjectInput(tb))),
    );

    await harness.unmount({ mountId: "a" });
    await harness.unmount({ mountId: "b" });
  });

  it("injects NO time-varying default (no date/clock) into the stable prefix", async () => {
    const harness = await makeCompiler();
    await mount(harness, "m");
    const { tree } = await harness.renderTree({ mountId: "m", sessionId: "s" });

    const input = defaultProject(toProjectInput(tree));

    // The framework adds no timestamp/date/clock anywhere in the model input.
    expect(JSON.stringify(input)).not.toMatch(TIME_VARYING);

    // Positive control: the authored content IS present (so the negative
    // above is meaningful, not vacuous on an empty prefix).
    const systemText = input.messages
      .filter((m) => m.role === "system")
      .flatMap((m) => m.content)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    expect(systemText).toContain("You are a helpful assistant.");
    expect(systemText).toContain("House rules");

    await harness.unmount({ mountId: "m" });
  });

  it("across N ticks of a real loop run, the compiled prefix is append-only", async () => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const executor = new RecordingExecutor("rec-exec", journal, bus, inbox);
    await executor.ready;

    const noop: ToolHandler = async () => [{ type: "text", text: "" } satisfies ContentBlock];

    const app = await createApp(React.createElement(RepresentativeAgent), {
      modelExecutor: executor,
      target: mkTarget(),
      journal,
      bus,
      inbox,
      toolHandlers: new Map<string, ToolHandler>([
        ["handlers/search", noop],
        ["handlers/noop", noop],
      ]),
    });

    const session = await app.createSession({ sessionId: "loop" });
    for (const text of ["first message", "second message", "third message"]) {
      const handle = await session.send({ messages: [{ role: "user", content: text }] });
      await handle.result;
    }
    await session.close();
    await app.closeApp();

    // One projection per tick; each execution here is a single tick.
    expect(executor.captured.length).toBeGreaterThanOrEqual(3);
    const projected = executor.captured.map((pi) => defaultProject(pi));

    // The cacheable HEAD is byte-identical on every tick: the system
    // message (folded from the static sections) never drifts…
    const systemBytes = projected.map((p) =>
      JSON.stringify(p.messages.filter((m) => m.role === "system")),
    );
    for (const s of systemBytes) expect(s).toBe(systemBytes[0]);

    // …and the tool list (static declarations) never drifts.
    const toolBytes = projected.map((p) => JSON.stringify(p.tools ?? []));
    for (const t of toolBytes) expect(t).toBe(toolBytes[0]);

    // PREFIX-APPEND-ONLY: tick N's full message list is a byte-identical
    // prefix of tick N+1's — later ticks only APPEND new conversation
    // entries. This is the actual provider prompt-cache property.
    for (let i = 1; i < projected.length; i++) {
      const prev = projected[i - 1]!.messages;
      const curr = projected[i]!.messages;
      expect(curr.length).toBeGreaterThanOrEqual(prev.length);
      expect(JSON.stringify(curr.slice(0, prev.length))).toBe(JSON.stringify(prev));
    }
  });
});
