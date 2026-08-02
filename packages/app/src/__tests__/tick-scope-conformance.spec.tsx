/**
 * **Every operation emitted between a tick's start and its end must carry that
 * tick's `tickId`.**
 *
 * This is the structural guard for the Effect-to-the-edge law. `RuntimeContext`
 * — which carries `tickId` / `executionId` / `opId` — is ambient ON the fiber, so
 * a single `runPromise` root anywhere between the loop's tick body and a
 * downstream harness silently drops it. Nothing goes red: the harness still
 * works, the envelope is still published, it just has no tick on it.
 *
 * Three separate places got that wrong before this existed, each defended by a
 * plausible comment:
 *
 *   - `TimelineHarness` had NO `fx` twins at all, so every append went through
 *     the Promise facade. `BaseHarness` hands out a working `.fx` carrying
 *     `use`, so an empty operation surface typechecked and resolved.
 *   - `SessionHarness.applyExecutorResultFx` was an Effect whose FIRST statement
 *     was `Effect.tryPromise(() => this.applyExecutorResultBody(...))` — it
 *     composed in the loop's fiber and immediately left it.
 *   - the loop awaited `notifyTickEnd` through a bare `Effect.tryPromise`,
 *     documented as "in-fiber, NOT a severing root". True of the LOOP's fiber;
 *     false of the callback's body, which is where the steer drain appends.
 *
 * Asserting per-seam would have missed all three, because each was reached
 * through a different seam. This asserts the INVARIANT instead, over whatever
 * actually fires — so a harness added tomorrow is covered without being named.
 *
 * ## Why the bus and not hooks
 *
 * `CommandHooks` requires NAMING each key, and a package can only name keys
 * whose augmenting module is in its compilation. `ProtocolEvent` is spec-owned
 * and every operation publishes one with its `scope` attached, so a subscriber
 * sees every harness uniformly — including ones this package has never heard of.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { createApp } from "../react.js";
import type {
  AdapterDelta,
  ExecuteInput,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelTarget,
  ProtocolEvent,
} from "@agentick/spec";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";

const Agent = (): React.ReactElement =>
  React.createElement("message", { role: "system" }, "you are a test");

const TARGET: LanguageModelTarget = {
  kind: "language-model",
  provider: "stub",
  modelId: "stub-v1",
  capabilities: { supportsStreaming: true },
};

function stubAdapter(): LanguageModelAdapter<{ text: string }, { raw: string }, unknown> {
  return {
    provider: "stub",
    target: TARGET,
    prepareRequest: (input: ExecuteInput<LanguageModelInput>) => ({
      model: input.target.modelId ?? "stub-v1",
    }),
    send: async () => ({ text: "ok" }),
    openStream: async function* () {
      yield { raw: "o" };
      yield { raw: "k" };
    },
    mapChunk: (chunk, accum: StreamAccumulatorView): readonly AdapterDelta[] => [
      ...(accum.textByBlock.has(0)
        ? []
        : ([{ type: "content-start", blockIndex: 0, blockType: "text" }] as const)),
      { type: "content-delta", blockIndex: 0, delta: chunk.raw },
    ],
    reconstructRaw: (accum: StreamAccumulatorView) => ({ text: accum.totalText() }),
    normalize: (raw): LanguageModelExecutionResult => ({
      specVersion: "2026-05-08",
      output: [{ type: "text", text: raw.text }],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  };
}

/**
 * Operations that legitimately have NO tick.
 *
 * `session:command:send` BRACKETS the ticks — it starts before the first and
 * settles after the last, so it is execution-scoped by construction. Same for
 * the app/session lifecycle verbs and the turn boundary, which is a TURN fact.
 * Everything else emitted inside the bracket is doing work FOR a tick and must
 * say which one.
 */
const TICKLESS = new Set([
  "session:command:send",
  "session:command:append",
  "app:command:create-session",
  "app:command:close-app",
  "timeline:command:endTurn",
]);

/** Drive one send and collect every envelope, in publish order. */
async function collectEnvelopes(): Promise<readonly ProtocolEvent[]> {
  const seen: ProtocolEvent[] = [];
  const app = await createApp(React.createElement(Agent), { model: stubAdapter() });
  const pump = (async () => {
    for await (const event of app.events()) seen.push(event);
  })();
  void pump;
  try {
    const session = await app.createSession();
    await (
      await session.send({ messages: [{ role: "user", content: "ping" }] })
    ).result;
    // Let the subscriber drain what the execution published.
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    await app.closeApp();
  }
  return seen;
}

describe("tick scope — every op inside a tick carries its tickId", () => {
  it("publishes a tick with an id at all (guard: the rest is vacuous without this)", async () => {
    const seen = await collectEnvelopes();
    const ticks = seen.filter((e) => e.name === "loop:command:tick");
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]!.scope?.tickId).toBeTruthy();
  });

  it("no operation between tick-start and tick-end is missing its tickId", async () => {
    const seen = await collectEnvelopes();

    // The tick bracket, by envelope order — the same order a subscriber sees.
    const start = seen.findIndex((e) => e.name === "loop:command:tick" && e.phase !== "terminal");
    const end =
      seen.length - 1 - [...seen].reverse().findIndex((e) => e.name === "loop:command:tick");
    expect(start).toBeGreaterThanOrEqual(0);

    const offenders = seen
      .slice(start, end + 1)
      .filter((e) => e.scope?.tickId === undefined)
      .filter((e) => !TICKLESS.has(e.name))
      .map((e) => e.name);

    // Report the NAMES, not a count — a failure here says WHICH harness severed
    // the fiber, which is the whole diagnostic. Verified to bite: reverting
    // `appendMessageEntryFx` to the timeline's Promise facade fails this with
    // `[ 'timeline:command:append' ]`.
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("covers more than one harness, or it proves nothing", async () => {
    const seen = await collectEnvelopes();
    const surfaces = new Set(
      seen.filter((e) => e.scope?.tickId !== undefined).map((e) => e.surface),
    );
    // compiler + model + timeline at minimum — the three siblings under a tick
    // that are joined by nothing except this id.
    expect(surfaces.size).toBeGreaterThanOrEqual(3);
  });
});
