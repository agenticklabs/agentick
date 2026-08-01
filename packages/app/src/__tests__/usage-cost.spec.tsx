/**
 * Usage → cost, app side (`docs/proposals/v2/usage-cost.md`).
 *
 * Two claims live here:
 *
 *  1. `AppHarnessOptions.costResolver` — the pricing seam — reaches the
 *     loop's `ExecutionRunInput`, on host-created sessions AND on spawned
 *     children (which inherit it through the one session-construction body).
 *  2. §7.1 — a spawned child's cost lands in the CHILD's `SessionRecord` and
 *     is deliberately absent from the parent's. Attribution across an agent
 *     tree is a query over `spawnPath`, never a write-time rollup.
 *
 * The loop is a `defineLoop` stub throughout: it is the component that
 * STAMPS cost at tick settlement, so a test of the seam that used the real
 * loop would be testing the loop, not the threading. The stub drives the
 * session's real `stateApplicator.applyExecutorResult` — the actual seam the
 * loop uses — so the session-side fold under test is the shipped one.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { defineLoop } from "@agentick/loop-executor";
import { scriptedAdapter } from "@agentick/model/testing";
import type {
  Cost,
  CostRollup,
  ExecutionTarget,
  ExecutionTerminal,
  RunExecutionInput,
  CostResolver,
  SessionExecutionHandle,
} from "@agentick/spec";
import { foldUsageRollup } from "@agentick/spec";

import { createApp } from "../react.js";

function MinimalAgent() {
  return React.createElement("message" as never, { role: "user" }, "hi");
}

const USAGE = { inputTokens: 100, outputTokens: 50, totalTokens: 150 } as const;

const priced = (micros: number, rateRef = "test:card@2026-07-31"): Cost => ({
  amountMicros: micros,
  currency: "USD",
  rateRef,
});

interface ScriptedTick {
  readonly model?: Pick<ExecutionTarget, "provider" | "modelId">;
  readonly cost?: Cost;
}

/**
 * A `defineLoop` stub that plays `ticks` through the session's real state
 * applicator and records every `RunExecutionInput` it saw. The run's own
 * `byModel` / `cost` are folded with spec's `foldUsageRollup` — the same
 * arithmetic the shipped loop uses, and the reason `Cost` (one tick's
 * stamped amount) and `CostRollup` (the `complete` | `partial` fold) are
 * separate types: hand-rolling the rollup is the mistake the split catches.
 */
function scriptedLoop(ticks: readonly ScriptedTick[], seen: RunExecutionInput[]) {
  return defineLoop({
    async runExecution(input): Promise<ExecutionTerminal> {
      seen.push(input);
      let i = 0;
      let rollup: ReturnType<typeof foldUsageRollup> | undefined;
      for (const tick of ticks) {
        rollup = foldUsageRollup(rollup, tick.model, { ...USAGE }, tick.cost);
        await input.stateApplicator.applyExecutorResult({
          sessionId: input.sessionId,
          executionId: input.executionId,
          tickId: `tick-${i++}`,
          result: {
            specVersion: "2026-05-08",
            output: [{ type: "text", text: "ok" }],
            stopReason: "end",
            usage: { ...USAGE },
            ...(tick.cost !== undefined ? { cost: tick.cost } : {}),
            ...(tick.model !== undefined ? { model: tick.model } : {}),
          },
        });
      }
      const cost: CostRollup | undefined = rollup?.cost;
      return {
        outcome: "succeeded",
        result: {
          executionId: input.executionId,
          ticks: ticks.length,
          usage: rollup?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          stopReason: "end",
          output: [{ type: "text", text: "ok" }],
          toolResults: [],
          ...(rollup !== undefined ? { byModel: rollup.byModel } : {}),
          ...(cost !== undefined ? { cost } : {}),
        },
      };
    },
  });
}

const OPUS = { provider: "anthropic", modelId: "claude-opus" } as const;

describe("AppHarnessOptions.costResolver — the pricing seam", () => {
  it("reaches the loop's ExecutionRunInput", async () => {
    const seen: RunExecutionInput[] = [];
    const costResolver: CostResolver = () => priced(1234);
    const app = await createApp(React.createElement(MinimalAgent), {
      model: scriptedAdapter("hi"),
      loop: scriptedLoop([{ model: OPUS, cost: priced(1234) }], seen),
      costResolver,
    });
    const session = await app.createSession();
    await (
      await session.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;

    expect(seen).toHaveLength(1);
    // Forwarded verbatim — the loop, not the session, is the pricing site.
    expect(seen[0]!.costResolver).toBe(costResolver);

    await app.closeApp();
  });

  it("is absent from the run input when the app declares none", async () => {
    const seen: RunExecutionInput[] = [];
    const app = await createApp(React.createElement(MinimalAgent), {
      model: scriptedAdapter("hi"),
      loop: scriptedLoop([{}], seen),
    });
    const session = await app.createSession();
    await (
      await session.send({ messages: [{ role: "user", content: "hi" }] })
    ).result;

    // Not `undefined`-valued: the key never lands on the input at all.
    expect("costResolver" in seen[0]!).toBe(false);

    await app.closeApp();
  });

  it("a SPAWNED child inherits it — the seam rides the one construction body", async () => {
    const seen: RunExecutionInput[] = [];
    const costResolver: CostResolver = () => priced(7);
    const app = await createApp(React.createElement(MinimalAgent), {
      model: scriptedAdapter("hi"),
      loop: scriptedLoop([{ model: OPUS, cost: priced(7) }], seen),
      costResolver,
    });
    const parent = await app.createSession();
    // `send` on the spawn runs one execution against the child and returns
    // its handle — the bound form, so `.result` is the child's turn.
    const child = (await parent.spawn({
      send: { messages: [{ role: "user", content: "go" }] },
    })) as SessionExecutionHandle;
    await child.result;

    expect(seen).toHaveLength(1);
    expect(seen[0]!.costResolver).toBe(costResolver);

    await app.closeApp();
  });
});

describe("usage-cost §7.1 — a sub-agent's cost is a query, never a parent-ward write", () => {
  it("the spawned child's cost lands on the CHILD's record, not the parent's", async () => {
    const seen: RunExecutionInput[] = [];
    const app = await createApp(React.createElement(MinimalAgent), {
      model: scriptedAdapter("hi"),
      loop: scriptedLoop([{ model: OPUS, cost: priced(500) }], seen),
    });
    const parent = await app.createSession();

    // The parent itself never sends — its record must stay empty of cost.
    // `send` on the spawn runs one execution against the child and returns
    // its handle — the bound form, so `.result` is the child's turn.
    const child = (await parent.spawn({
      send: { messages: [{ role: "user", content: "go" }] },
    })) as SessionExecutionHandle;
    await child.result;

    const childRecord = await app.getSessionRecord(seen[0]!.sessionId);
    expect(childRecord?.cost).toEqual({
      kind: "complete",
      amountMicros: 500,
      currency: "USD",
      ticks: 1,
      rateRefs: ["test:card@2026-07-31"],
    });
    expect(childRecord?.spawnPath).toContain(parent.id);

    const parentRecord = await app.getSessionRecord(parent.id);
    // Not a zero rollup, not a partial — ABSENT. The parent spent nothing and
    // the child's spend is not the parent's to claim.
    expect(parentRecord?.cost).toBeUndefined();
    expect(parentRecord?.byModel).toBeUndefined();

    await app.closeApp();
  });
});
