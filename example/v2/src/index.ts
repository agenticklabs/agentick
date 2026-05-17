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
  DispatchInput,
  MessageEnvelope,
  ProtocolEvent,
  ReconcilerInboxMessage,
  RenderedTree,
  ToolDeclaration,
} from "@agentick/spec";

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
 * Subscribe to the bus before running an operation, then collect the
 * envelopes that flowed through. Both reconciler + tool harnesses
 * publish on the same bus.
 */
async function scenarioBusSubscription(s: Substrate): Promise<void> {
  console.log(heading("5. Bus subscription — observe every operation"));

  // A dispatch publishes 3 envelopes (requested → before → terminal).
  const fiber = Effect.runFork(
    Stream.runCollect(Stream.take(s.bus.subscribe({}), 3)),
  );
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
  const chunk = await Effect.runPromise(
    Stream.runCollect(s.journal.read({}, "beginning")),
  );
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
