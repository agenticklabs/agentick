/**
 * Tool handlers + handler resolver setup for the example.
 *
 * The spec firewall forbids `ToolDeclaration` from embedding executable
 * code — declarations only carry `handlerRef: string`. Handlers register
 * out-of-band in the `HandlerResolver`. This module wires both halves so
 * the JSX agent's `<Tool handlerRef="handlers/calculator" />` resolves to
 * a concrete function at dispatch time.
 *
 * Handlers can be plain async, or Effect — `createTool` (when it lands)
 * will accept both. For now we register raw functions.
 */

import { Effect } from "effect";
import { getContext } from "@agentick/runtime";
import { InMemoryHandlerResolver } from "@agentick/tool-executor";
import type { ContentBlock } from "@agentick/spec";

export function buildHandlerResolver(): InMemoryHandlerResolver {
  const resolver = new InMemoryHandlerResolver();

  // Plain async handler — the 90% case.
  resolver.register("handlers/calculator", async (input) => {
    const { expression } = input as { expression: string };
    // Trivial expression evaluator — for example purposes only. Don't
    // do this in production; use a real parser.
    const result = Function(`"use strict"; return (${expression});`)();
    return [{ type: "text", text: String(result) } satisfies ContentBlock];
  });

  // Handler that surfaces the current session scope via the
  // harness-plumbed `ctx`. Promise-typed handlers are NOT inside an
  // Effect fiber, so `getContext` (the FiberRef API) returns
  // EMPTY_CONTEXT here — the BaseHarness only owns the FiberRef while
  // an Effect is running. The harness explicitly plumbs sessionId /
  // executionId / tickId / toolCallId into `ctx` so Promise handlers
  // can read scope without parameter threading.
  //
  // Once we accept Effect-typed handlers (open question — see README
  // "What this surfaces"), they'll see `getContext` directly without
  // the ctx bridge.
  resolver.register("handlers/whoami", async (_input, { ctx }) => {
    return [
      {
        type: "text",
        text: [
          `sessionId=${ctx.sessionId ?? "(none)"}`,
          `executionId=${ctx.executionId ?? "(none)"}`,
          `tickId=${ctx.tickId ?? "(none)"}`,
          `toolCallId=${ctx.toolCallId}`,
        ].join(" · "),
      } satisfies ContentBlock,
    ];
  });

  // Handler that fails on purpose — the dispatch surfaces this as a
  // `terminal:failed` envelope on the bus + journal.
  resolver.register("handlers/explode", async () => {
    throw new Error("intentional failure for example purposes");
  });

  // Effect-typed handler. Sees the FiberRef-backed RuntimeContext
  // directly via `getContext` — no ctx plumbing needed. The harness
  // forks this as a Fiber so `Fiber.interrupt` cancels deterministically
  // when the dispatch aborts, and any `Effect.scoped` finalizers in the
  // body run as the fiber unwinds.
  resolver.register("handlers/effect-whoami", () =>
    Effect.gen(function* () {
      const scope = yield* getContext;
      return [
        {
          type: "text",
          text: [
            "(via getContext / FiberRef)",
            `sessionId=${scope.sessionId ?? "(none)"}`,
            `executionId=${scope.executionId ?? "(none)"}`,
            `tickId=${scope.tickId ?? "(none)"}`,
            `opId=${scope.opId ?? "(none)"}`,
            `parentOpId=${scope.parentOpId ?? "(none)"}`,
          ].join(" · "),
        } satisfies ContentBlock,
      ];
    }),
  );

  // Handler that uses ctx.signal — exercise abort plumbing.
  resolver.register("handlers/slow", async (input, deps) => {
    const ms = ((input as { ms?: number }).ms ?? 1000);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      deps.ctx.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(deps.ctx.signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
    return [{ type: "text", text: `slept ${ms}ms` } satisfies ContentBlock];
  });

  return resolver;
}
