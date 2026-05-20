/**
 * Example v2 — substrate driver.
 *
 * Walks through every harness surface we have today (reconciler +
 * tool-executor on the Effect substrate) and prints what's happening at
 * each step. Run with `pnpm --filter example-v2 dev`.
 *
 * What this exercises:
 *
 *   1. JSX agent → mount → RenderedTree IR
 *   2. Markdown render of the same agent
 *   3. Tool registration from the rendered tree's declarations
 *   4. Tool dispatch (happy path, FiberRef-backed context, abort, failure)
 *   5. Bus subscription — every operation envelope across both harnesses
 *   6. Journal inspection — durable audit log
 *   7. Inbox tell — send a `recompile` message to the reconciler
 *
 * What's NOT here yet (waiting on later phases):
 *
 *   - Executor harness (Phase 4c) — no model call, no token streaming
 *   - Loop executor (Phase 4d) — no multi-tick orchestration
 *   - Session harness (Phase 4e) — no `app.session(id).send({ messages })`
 *   - App harness (Phase 4f) — no `createApp(<Agent />, { model })`
 *
 * Each scenario below is a function — easy to comment out, easy to
 * extend when a new harness lands.
 */

import { Chunk, Effect, Fiber, Stream } from "effect";
import React from "react";
import type {
  ContentBlock,
  DispatchInput,
  MessageEnvelope,
  ProtocolEvent,
  ReconcilerInboxMessage,
  RenderedTree,
  ToolDeclaration,
} from "@agentick/spec";
import { createApp } from "@agentick/app";
import { MockLanguageModelExecutor } from "@agentick/executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { SupportAgent } from "./agent.js";
import { buildSubstrate, type Substrate } from "./substrate.js";

const SESSION_ID = "user-42";
const MOUNT_ID = "support-mount";

// ─────────────────────────────────────────────────────────────────────────────
// Pretty-print helpers
// ─────────────────────────────────────────────────────────────────────────────

const heading = (s: string) => `\n${"═".repeat(72)}\n  ${s}\n${"═".repeat(72)}`;
const sub = (s: string) => `\n── ${s} ${"─".repeat(Math.max(0, 68 - s.length))}`;
const line = (s: string) => `   ${s}`;

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mount the JSX agent and produce a RenderedTree. The harness is doing
 * the React reconcile + collect inside; we see only the IR.
 */
async function scenarioMountAndRender(s: Substrate): Promise<RenderedTree> {
  console.log(heading("1. Mount + renderTree → RenderedTree IR"));

  await s.reconciler.mount({
    mountId: MOUNT_ID,
    sessionId: SESSION_ID,
    element: React.createElement(SupportAgent),
    bridges: s.bridges,
    defaultFormatter: { id: "markdown", format: "markdown" },
  });
  console.log(line(`mounted ${MOUNT_ID} for session ${SESSION_ID}`));

  const { tree, iterations, diagnostics } = await s.reconciler.renderTree({
    mountId: MOUNT_ID,
    sessionId: SESSION_ID,
  });

  console.log(line(`iterations=${iterations}  diagnostics=${diagnostics.length}`));
  console.log(line(`spec version: ${tree.specVersion}`));
  console.log(line(`context entries: ${tree.context.entries.length}`));
  for (const entry of tree.context.entries) {
    if (entry.kind === "section") {
      console.log(line(`  · section "${entry.id}"  title=${entry.title ?? "(none)"}`));
    } else {
      console.log(line(`  · message role=${entry.role}  blocks=${entry.content.length}`));
    }
  }
  const tools = tree.declarations?.tools ?? [];
  console.log(line(`declared tools: ${tools.length}`));
  for (const t of tools) {
    console.log(line(`  · ${t.name} — ${t.description}`));
  }

  return tree;
}

/**
 * Render the same mount to a string (markdown). Phase 3.13 wires a
 * pragmatic default serializer until the formatter harness (Phase 4a)
 * lands and replaces it.
 */
async function scenarioRenderToString(s: Substrate): Promise<void> {
  console.log(heading("2. renderToString → markdown"));
  const { payload, iterations } = await s.reconciler.renderToString({
    mountId: MOUNT_ID,
  });
  console.log(line(`iterations=${iterations}  mimeType=${payload.mimeType}`));
  console.log(sub("payload.text"));
  for (const ln of payload.text.split("\n")) console.log(`   │ ${ln}`);
}

/**
 * Register every tool the agent declared with the tool executor. In a
 * real app the session harness (Phase 4e) does this automatically when
 * processing the rendered tree; we do it by hand here.
 */
async function scenarioRegisterTools(
  s: Substrate,
  declarations: readonly ToolDeclaration[],
): Promise<void> {
  console.log(heading("3. Tool registration from the rendered tree"));
  for (const decl of declarations) {
    await s.tools.register({
      registration: { declaration: decl, handlerRef: decl.handlerRef ?? `handlers/${decl.name}` },
    });
    console.log(line(`registered "${decl.name}" → ${decl.handlerRef}`));
  }
  const listed = await s.tools.list();
  console.log(line(`harness now exposes ${listed.length} tools`));
}

/**
 * Happy-path dispatch. The handler runs inside `runOperation`, which
 * has already established the FiberRef RuntimeContext for the command
 * — `whoami` reads sessionId/etc via `getContext` (no parameter
 * plumbing).
 */
async function scenarioDispatchHappyPath(s: Substrate): Promise<void> {
  console.log(heading("4a. Tool dispatch — happy path"));

  const calc = await s.tools.dispatch({
    toolCallId: "tc-calc-1",
    name: "calculator",
    input: { expression: "47 * 23" },
    context: {
      via: "model",
      sessionId: SESSION_ID,
      executionId: "exec-1",
      tickId: "tick-1",
    },
  } satisfies DispatchInput);
  console.log(line(`calculator → ${(calc.content[0] as { text: string }).text}`));

  const whoami = await s.tools.dispatch({
    toolCallId: "tc-whoami-1",
    name: "whoami",
    input: {},
    context: {
      via: "model",
      sessionId: SESSION_ID,
      executionId: "exec-1",
      tickId: "tick-1",
    },
  } satisfies DispatchInput);
  console.log(line(`whoami → ${(whoami.content[0] as { text: string }).text}`));

  const effectWhoami = await s.tools.dispatch({
    toolCallId: "tc-effect-whoami-1",
    name: "effect-whoami",
    input: {},
    context: {
      via: "model",
      sessionId: SESSION_ID,
      executionId: "exec-1",
      tickId: "tick-1",
    },
  } satisfies DispatchInput);
  console.log(line(`effect-whoami → ${(effectWhoami.content[0] as { text: string }).text}`));
}

/**
 * Abort path — start a slow dispatch, cancel mid-flight via abort().
 */
async function scenarioDispatchAbort(s: Substrate): Promise<void> {
  console.log(heading("4b. Tool dispatch — abort"));

  const dispatchP = s.tools.dispatch({
    toolCallId: "tc-slow-1",
    name: "slow",
    input: { ms: 5_000 },
    context: { via: "model", sessionId: SESSION_ID },
  } satisfies DispatchInput);

  // Abort after 50ms.
  setTimeout(() => {
    void s.tools.abort({ toolCallId: "tc-slow-1", reason: "demonstration" });
  }, 50);

  try {
    await dispatchP;
    console.log(line("(unexpected) slow tool returned without aborting"));
  } catch (err) {
    const tag = (err as { _tag?: string })._tag ?? "unknown";
    console.log(line(`slow tool rejected as ${tag}`));
  }
}

/**
 * Failure path — tool throws, the harness publishes terminal:failed and
 * the original error surfaces to the caller.
 */
async function scenarioDispatchFailure(s: Substrate): Promise<void> {
  console.log(heading("4c. Tool dispatch — handler failure"));
  try {
    await s.tools.dispatch({
      toolCallId: "tc-boom-1",
      name: "explode",
      input: {},
      context: { via: "model", sessionId: SESSION_ID },
    } satisfies DispatchInput);
    console.log(line("(unexpected) explode did not throw"));
  } catch (err) {
    const tag = (err as { _tag?: string })._tag ?? "unknown";
    const cause = (err as { cause?: unknown }).cause;
    console.log(line(`explode rejected as ${tag}  cause=${(cause as Error)?.message}`));
  }
}

/**
 * Subscribe to a channel before dispatching a streaming tool. The tool
 * emits progress updates via `ctx.emit({ name: "session:channel:..." })`;
 * the LocalChannelPublisher assigns sequence numbers and routes through
 * the bus.
 *
 * When the session harness lands (Phase 4e), the same code works
 * unchanged — the publisher just becomes the session's, with retention
 * + replay-from-offset added on top.
 */
async function scenarioChannelStreaming(s: Substrate): Promise<void> {
  console.log(heading("4d. Channel streaming — ctx.emit → ChannelPublisher → bus"));

  type Progress = {
    step: number;
    totalSteps: number;
    percent: number;
    message: string;
  };

  const fiber = Effect.runFork(
    Stream.runCollect(
      Stream.take(
        s.bus.subscribe({
          surface: "session",
          name: { exact: "session:channel:tool-progress" },
        }),
        3,
      ),
    ),
  );
  await new Promise((r) => setImmediate(r));

  await s.tools.dispatch({
    toolCallId: "tc-progress-1",
    name: "progress",
    input: { steps: 3 },
    context: { via: "model", sessionId: SESSION_ID, executionId: "exec-1" },
  } satisfies DispatchInput);

  const chunk = await Effect.runPromise(Fiber.join(fiber));
  for (const ev of Chunk.toReadonlyArray(chunk)) {
    const channelEv = ev as typeof ev & {
      channelSequence: number;
      payload: Progress;
    };
    console.log(
      line(
        `channel#${channelEv.channelSequence}: ` +
          `${channelEv.payload.percent}% — ${channelEv.payload.message}`,
      ),
    );
  }
  console.log(line(`publisher current sequence: ${s.channels.sequenceOf("tool-progress")}`));
}

/**
 * End-to-end agent loop: the loop executor orchestrates reconciler +
 * executor + tool-executor across multiple ticks.
 *
 * Scripted flow (via the mock executor's scripted sequence in
 * substrate.ts):
 *
 *   Tick 1: render → executor returns tool_use(calculator, "47 * 23")
 *           → loop dispatches calculator → result "1081"
 *           → stateApplicator records the apply
 *   Tick 2: render → executor returns final text "47 × 23 = 1081."
 *           → stopReason: end → loop terminates
 *
 * The full execution emits per-phase events on `surface: "loop"` —
 * one subscriber sees the entire orchestration without composing four
 * other harnesses' streams.
 *
 * Real provider adapters (Phase 4c) slot in unchanged: same
 * ExecutorProtocol, same loop algorithm. The loop is provider-agnostic.
 */
async function scenarioLoopExecution(s: Substrate, tree: RenderedTree): Promise<void> {
  console.log(heading("4e. Loop executor — reconciler + executor + tool-executor"));

  type Delta = { kind: string; delta?: string };
  // Subscribe to delta envelopes from the executor (streaming model
  // tokens) BEFORE we start the loop so we capture them.
  const deltaFiber = Effect.runFork(
    Stream.runCollect(Stream.take(s.bus.subscribe({ surface: "executor", phase: "delta" }), 5)),
  );
  await new Promise((r) => setImmediate(r));

  const terminal = await s.loop.runExecution({
    executionId: "exec-loop-1",
    sessionId: SESSION_ID,
    reconciler: s.reconciler,
    mountId: MOUNT_ID,
    executor: s.executor,
    target: {
      kind: "language-model",
      provider: "mock",
      modelId: "mock-v1",
      capabilities: { supportsTools: true, supportsStreaming: true },
    },
    toolExecutor: s.tools,
    stateApplicator: s.stateApplicator,
    maxTicks: 4,
  });

  console.log(line(`outcome: ${terminal.outcome}`));
  if (terminal.outcome === "succeeded" && terminal.result) {
    const r = terminal.result;
    console.log(line(`ticks: ${r.ticks}`));
    console.log(line(`stopReason: ${r.stopReason}`));
    console.log(
      line(
        `usage: in=${r.usage.inputTokens} out=${r.usage.outputTokens} total=${r.usage.totalTokens}`,
      ),
    );
    const finalText = r.output
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (finalText.length > 0) console.log(line(`final text: ${finalText}`));
    console.log(line(`tool dispatch results: ${r.toolResults.length}`));
    for (const tr of r.toolResults) {
      const text = tr.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      console.log(
        line(`  · ${tr.toolName} (${tr.toolCallId}) ${tr.succeeded ? "✓" : "✗"} → ${text}`),
      );
    }
  }

  const deltas = await Effect.runPromise(Fiber.join(deltaFiber));
  console.log(line(`streamed ${Chunk.size(deltas)} delta envelopes during tick 1:`));
  for (const ev of Chunk.toReadonlyArray(deltas)) {
    const d = ev.payload as Delta | undefined;
    console.log(line(`  · ${d?.kind ?? "?"}  delta=${JSON.stringify(d?.delta ?? "")}`));
  }
}

/**
 * Subscribe to the bus before running an operation, then collect the
 * envelopes that flowed through. Both reconciler + tool harnesses
 * publish on the same bus.
 */
async function scenarioBusSubscription(s: Substrate): Promise<void> {
  console.log(heading("5. Bus subscription — observe every operation"));

  // A dispatch publishes 3 envelopes (requested → before → terminal).
  const fiber = Effect.runFork(Stream.runCollect(Stream.take(s.bus.subscribe({}), 3)));
  await new Promise((r) => setImmediate(r));

  await s.tools.dispatch({
    toolCallId: "tc-bus-1",
    name: "calculator",
    input: { expression: "2 + 2" },
    context: { via: "model", sessionId: SESSION_ID },
  } satisfies DispatchInput);

  const chunk = await Effect.runPromise(Fiber.join(fiber));
  for (const ev of Chunk.toReadonlyArray(chunk)) {
    const outcome = ev.outcome ? ` outcome=${ev.outcome}` : "";
    console.log(line(`bus: ${ev.surface.padEnd(11)} ${ev.name}.${ev.phase}${outcome}`));
  }
}

/**
 * Drain the journal — a durable audit log of every requested/terminal
 * envelope the harnesses produced over the entire session so far.
 */
async function scenarioJournalAudit(s: Substrate): Promise<void> {
  console.log(heading("6. Journal — durable audit log"));
  const chunk = await Effect.runPromise(Stream.runCollect(s.journal.read({}, "beginning")));
  const events = Array.from(Chunk.toReadonlyArray(chunk));
  console.log(line(`total journaled envelopes: ${events.length}`));

  const byName = new Map<string, { requested: number; terminal: number; outcomes: string[] }>();
  for (const ev of events) {
    const entry = byName.get(ev.name) ?? { requested: 0, terminal: 0, outcomes: [] };
    if (ev.phase === "requested") entry.requested++;
    if (ev.phase === "terminal") {
      entry.terminal++;
      if (ev.outcome) entry.outcomes.push(ev.outcome);
    }
    byName.set(ev.name, entry);
  }
  for (const [name, entry] of byName) {
    console.log(
      line(
        `${name.padEnd(40)} req=${entry.requested} term=${entry.terminal} [${entry.outcomes.join(",")}]`,
      ),
    );
  }
}

/**
 * The framework end-to-end: `session.send({ messages })` runs the full
 * agent. The session owns its own mount, provides bridges backed by
 * session state, delegates to the loop executor, and resolves with a
 * fully-assembled `SendResult` carrying the response text + tool
 * outputs + usage.
 *
 * This is what application authors actually call. Everything above
 * (reconciler, executor, tool-executor, loop, channel publisher) is
 * substrate — the session wraps it.
 */
async function scenarioSessionSend(s: Substrate): Promise<void> {
  console.log(heading("4f. Session — session.send({ messages })"));

  const handle = await s.session.send({
    messages: [{ role: "user", content: "What is 47 times 23?" }],
  });
  console.log(line(`executionId: ${handle.executionId}`));

  const result = await handle.result;
  console.log(line(`response: ${result.response}`));
  console.log(line(`ticks: ${result.ticks}`));
  console.log(line(`stopReason: ${result.stopReason}`));
  console.log(
    line(
      `usage: in=${result.usage.inputTokens} out=${result.usage.outputTokens} total=${result.usage.totalTokens}`,
    ),
  );
  console.log(line(`tool dispatches: ${result.toolResults.length}`));

  console.log(sub("session.timeline()"));
  for (const entry of s.session.timeline()) {
    if (entry.kind !== "message") continue;
    const m = entry.message;
    const text = m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolUse = m.content.find((b) => b.type === "tool_use");
    const toolResult = m.content.find((b) => b.type === "tool_result");
    const tag = toolUse
      ? `[tool_use ${(toolUse as { name: string }).name}]`
      : toolResult
        ? `[tool_result]`
        : "";
    console.log(line(`  · ${m.role.padEnd(9)} ${tag} ${text}`.trimEnd()));
  }
}

/**
 * App harness — `createApp(<Agent />, { executor, target })` wraps every
 * lower layer. One factory call gives back an `AppHarness` that owns the
 * shared substrate + sub-harnesses + the session registry. The user
 * surface is `app.createSession()` / `app.runOnce()` / `app.closeApp()`.
 *
 * Real applications start here — `buildSubstrate()` and direct harness
 * construction (everything in `substrate.ts`) are the substrate
 * walkthrough, not the production path.
 */
async function scenarioAppHarness(): Promise<void> {
  console.log(heading("4g. App harness — createApp(<Agent />, opts)"));

  // The app's mock executor is independent of the earlier scenarios'
  // executor (which has been drained by the loop/session demos).
  const executor = new MockLanguageModelExecutor(
    "app-demo-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08",
            output: [
              {
                type: "tool_use",
                toolUseId: "tc-app-calc",
                name: "calculator",
                input: { expression: "47 * 23" },
              },
            ],
            stopReason: "tool_use",
            toolCalls: [
              {
                id: "tc-app-calc",
                name: "calculator",
                input: { expression: "47 * 23" },
              },
            ],
            usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
          },
        },
        {
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "47 × 23 = 1081." }],
            stopReason: "end",
            usage: { inputTokens: 14, outputTokens: 9, totalTokens: 23 },
          },
        },
      ],
    },
  );
  await executor.ready;

  // Note the absence of an explicit `target` — the executor is
  // self-describing (FAÇADE.1) so createApp reads `executor.target`.
  const app = await createApp(React.createElement(SupportAgent), {
    executor,
    toolHandlers: new Map([
      [
        "handlers/calculator",
        async (input: unknown): Promise<readonly ContentBlock[]> => {
          const { expression } = input as { expression: string };
          const value = Function(`"use strict"; return (${expression});`)();
          return [{ type: "text", text: String(value) }];
        },
      ],
    ]),
  });
  console.log(line(`createApp returned an AppHarness`));

  // Path 1: ephemeral runOnce.
  const { result, sessionId } = await app.runOnce({
    send: { messages: [{ role: "user", content: "What is 47 * 23?" }] },
  });
  console.log(line(`runOnce sessionId=${sessionId}`));
  console.log(line(`runOnce response: ${result.response}`));
  console.log(line(`runOnce ticks=${result.ticks} stop=${result.stopReason}`));

  // Path 2: persistent session via createSession.
  const session = await app.createSession({
    sessionId: "user-43",
    metadata: { tier: "pro" },
  });
  console.log(
    line(`createSession → ${session === app.getSession("user-43") ? "registered" : "MISSING"}`),
  );
  const listing = app.listSessions({ metadata: { tier: "pro" } });
  console.log(
    line(
      `listSessions filter(tier=pro): ${listing.length} entr${listing.length === 1 ? "y" : "ies"}`,
    ),
  );

  await app.closeApp();
  console.log(line(`closeApp ✓`));
}

/**
 * AI SDK bridge — drive the loop through `@agentick/executor-ai-sdk`
 * using an inline `LanguageModelV2` stub. Proves the bridge works
 * end-to-end without needing an API key; swap in `@ai-sdk/anthropic`
 * or `@ai-sdk/google` (and a real model id) and the same code runs
 * against a live provider.
 *
 * The inline stub uses `@ai-sdk/provider`'s `LanguageModelV2` interface
 * directly rather than `ai/test`'s `MockLanguageModelV2` — keeps the
 * dep tree clean (no `msw`) and shows adopters the minimal surface a
 * provider implements.
 */
async function scenarioAISDK(): Promise<void> {
  const { aisdk } = await import("@agentick/executor-ai-sdk");
  type LanguageModelV2 = import("@ai-sdk/provider").LanguageModelV2;

  console.log(heading("4h. AI SDK bridge — createApp({ executor: aisdk({ model }) })"));

  // Scripted two-turn model:
  //   1. tool-call → calculator(47 * 23)
  //   2. text     → "47 × 23 = 1081."
  let turn = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "mock-aisdk",
    modelId: "mock-calc",
    supportedUrls: {},
    doGenerate: async () => {
      turn += 1;
      if (turn === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "tc-aisdk-calc",
              toolName: "calculator",
              input: JSON.stringify({ expression: "47 * 23" }),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "47 × 23 = 1081." }],
        finishReason: "stop" as const,
        usage: { inputTokens: 24, outputTokens: 11, totalTokens: 35 },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("streaming not implemented in this example");
    },
  };

  const app = await createApp(React.createElement(SupportAgent), {
    executor: aisdk({ model }),
    toolHandlers: new Map([
      [
        "handlers/calculator",
        async (input: unknown): Promise<readonly ContentBlock[]> => {
          const { expression } = input as { expression: string };
          const value = Function(`"use strict"; return (${expression});`)();
          return [{ type: "text", text: String(value) }];
        },
      ],
    ]),
  });
  console.log(line(`createApp via aisdk({ model: <inline LanguageModelV2 stub> })`));

  const { result, sessionId } = await app.runOnce({
    send: { messages: [{ role: "user", content: "What is 47 * 23?" }] },
  });
  console.log(line(`runOnce sessionId=${sessionId}`));
  console.log(line(`runOnce response: ${result.response}`));
  console.log(line(`runOnce ticks=${result.ticks} stop=${result.stopReason}`));
  console.log(line(`turns through the mock model: ${turn}`));

  await app.closeApp();
  console.log(line(`closeApp ✓`));
}

/**
 * Send an inbox message — the reconciler accepts `recompile`, `unmount`,
 * `invalidate`. The harness is an addressable actor at
 * `reconciler:{scopeId}` — the same call shape works once a cluster
 * inbox lands.
 */
async function scenarioInboxTell(s: Substrate): Promise<void> {
  console.log(heading("7. Inbox — tell the reconciler to invalidate cache"));

  const msg: MessageEnvelope<ReconcilerInboxMessage> = {
    addressedTo: "reconciler:example",
    type: "invalidate",
    messageId: "inv-1",
    timestamp: Date.now(),
    payload: { type: "invalidate", mountId: MOUNT_ID, keys: [] },
  };
  const ack = await Effect.runPromise(s.inbox.send("reconciler:example", msg));
  console.log(line(`ack messageId=${ack.messageId} receivedAt=${ack.receivedAt}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const s = await buildSubstrate(SESSION_ID);

  // Bus tap — log every envelope (in addition to the bounded scenario 5
  // subscription) for end-of-run inspection.
  const tap: ProtocolEvent[] = [];
  const tapFiber = Effect.runFork(
    Stream.runForEach(s.bus.subscribe({}), (ev) => Effect.sync(() => tap.push(ev))),
  );

  try {
    const tree = await scenarioMountAndRender(s);
    await scenarioRenderToString(s);
    await scenarioRegisterTools(s, tree.declarations?.tools ?? []);
    await scenarioDispatchHappyPath(s);
    await scenarioDispatchAbort(s);
    await scenarioDispatchFailure(s);
    await scenarioChannelStreaming(s);
    await scenarioLoopExecution(s, tree);
    await scenarioSessionSend(s);
    await scenarioAppHarness();
    await scenarioAISDK();
    await scenarioBusSubscription(s);
    await scenarioJournalAudit(s);
    await scenarioInboxTell(s);

    console.log(heading("Done"));
    console.log(line(`bus tap saw ${tap.length} envelopes total`));
  } finally {
    await Effect.runPromise(Fiber.interrupt(tapFiber));
    await s.reconciler.close();
    await s.tools.close();
  }
}

main().catch((err) => {
  console.error("example failed:", err);
  process.exit(1);
});
