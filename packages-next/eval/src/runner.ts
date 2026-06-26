/**
 * Internal eval runner — drives one invocation of a `defineEval`-
 * returned callable to completion.
 *
 * Flow per invocation:
 *   1. Resolve every createApp option: definition defaults +
 *      per-call overrides (overrides win).
 *   2. `createApp` with the resolved configuration.
 *   3. Subscribe to `app.events({ name: "tool:command:dispatch",
 *      phase: "terminal" })` to record every tool call.
 *   4. Build a fresh `EvalContext` (`t`) bound to this app + the
 *      assertion ledger.
 *   5. Invoke `definition.test(t)`.
 *   6. `app.closeApp()` — also stops the events subscription.
 *   7. Return the aggregated {@link EvalResult}.
 *
 * Assertions don't throw — they record into a ledger that the
 * result exposes. Adopters who want fail-fast can check
 * `result.passed` and decide whether to continue.
 */

import { createApp, type CreateAppOptions } from "@agentick/app-next";
import type { AppHarnessProtocol, EventQuery, ProtocolEvent } from "@agentick/spec-next";
import { isEqual } from "@agentick/utils-next";
import { waitFor } from "@agentick/utils-next/testing";

import type {
  AssertionResult,
  EvalContext,
  EvalDefinition,
  EvalInvocationOverrides,
  EvalResult,
  ObservedToolCall,
} from "./types.js";

// Subscribe to both requested + terminal so we can correlate the
// input (on requested) with the outcome (on terminal) for the
// observed-tool-call ledger.
const TOOL_DISPATCH_FILTER: EventQuery = {
  surface: "tool",
  name: { exact: "tool:command:dispatch" },
  phase: ["requested", "terminal"],
};

export async function runEval<P>(
  definition: EvalDefinition<P>,
  overrides: EvalInvocationOverrides<P> | undefined,
): Promise<EvalResult> {
  const started = Date.now();

  // Peel off the eval-specific fields. The rest is createApp opts.
  const { description, rootElement: defRoot, test, ...defAppOpts } = definition;
  void description;
  void test;
  const { rootElement: overrideRoot, ...overrideAppOpts } = overrides ?? {};

  // Merge createApp opts: definition is base, overrides shallowly
  // win. For metadata specifically we shallow-merge the records to
  // let matrix runs add axis tags without clobbering definition tags.
  const mergedMetadata: Record<string, unknown> = {
    ...(defAppOpts.metadata ?? {}),
    ...((overrideAppOpts as { metadata?: Record<string, unknown> }).metadata ?? {}),
  };

  const appOptions: CreateAppOptions<P> = {
    ...defAppOpts,
    ...overrideAppOpts,
    ...(Object.keys(mergedMetadata).length > 0 ? { metadata: mergedMetadata } : {}),
  } as CreateAppOptions<P>;

  // Construct the app for this invocation. Each invocation gets its
  // OWN app — the eval framework owns the lifecycle.
  const app = (await createApp(overrideRoot ?? defRoot, appOptions)) as AppHarnessProtocol<P>;

  // Subscribe to tool:command:dispatch terminal events on a background
  // task. Pushes into `toolCalls`. Aborts when the eval is done so
  // the iterator can exit even if app.closeApp() doesn't complete
  // pending iterator nexts.
  const toolCalls: ObservedToolCall[] = [];
  const eventsAbort = new AbortController();
  const eventsTask = consumeEvents(app, toolCalls, eventsAbort.signal);

  const assertions: AssertionResult[] = [];
  let lastSendStop: string | undefined;
  let evalError: { name: string; message: string } | undefined;

  // Build `t` (test context). Closes over the ledgers above.
  const t: EvalContext<P> = {
    app,
    async send(prompt) {
      const session = await app.createSession({});
      const beforeCount = toolCalls.length;
      try {
        const handle = await session.send({
          messages: [{ role: "user", content: prompt }],
        });
        const result = await handle.result;
        lastSendStop = result.stopReason;
        // If the model called any tools during this send, wait for
        // the corresponding terminal events to land in the ledger
        // before returning — synchronous t.calledTool assertions
        // that fire right after t.send must observe them. ticks is
        // the count from the SendResult (one tick per model call).
        // For each tool_use tick there's typically one tool call;
        // we wait until the ledger has at least one more entry than
        // it did pre-send. 200ms cap is generous for in-memory delivery.
        const expectedToolCalls = Math.max(0, result.ticks - 1);
        if (expectedToolCalls > 0) {
          try {
            await waitFor(() => toolCalls.length >= beforeCount + expectedToolCalls, {
              timeoutMs: 200,
              pollMs: 5,
              description: "tool-call events to land",
            });
          } catch {
            // Soft-fail — assertions that depend on the missing
            // events will record their own failures. Don't crash
            // the entire eval on a delivery timeout.
          }
        }
        return result.response;
      } finally {
        await session.close();
      }
    },
    completed() {
      const passed = lastSendStop === "end";
      assertions.push({
        kind: "completed",
        passed,
        message: passed
          ? "send completed with stopReason='end'"
          : `expected stopReason='end', got ${JSON.stringify(lastSendStop)}`,
      });
    },
    calledTool(name, opts) {
      const matches = toolCalls.filter((c) => c.name === name);
      const matchedExpected = matches.find((c) => {
        if (opts?.input !== undefined && !isEqual(c.input, opts.input)) return false;
        if (opts?.isError !== undefined) {
          const expectError = opts.isError;
          const actualError = c.outcome === "failed";
          if (expectError !== actualError) return false;
        }
        return true;
      });
      assertions.push({
        kind: "calledTool",
        passed: matchedExpected !== undefined,
        message: matchedExpected
          ? `tool "${name}" was called with expected input/outcome`
          : `expected tool "${name}" called${formatExpected(opts)}; observed ${matches.length === 0 ? "no calls to this tool" : `${matches.length} call(s) but none matched`}`,
        details: { name, matchedCount: matches.length, opts },
      });
    },
    notCalledTool(name) {
      const matches = toolCalls.filter((c) => c.name === name);
      const passed = matches.length === 0;
      assertions.push({
        kind: "notCalledTool",
        passed,
        message: passed
          ? `tool "${name}" was not called`
          : `expected tool "${name}" NOT called; observed ${matches.length} call(s)`,
        details: { name, observedCount: matches.length },
      });
    },
    noFailedActions() {
      const failures = toolCalls.filter((c) => c.outcome === "failed");
      const passed = failures.length === 0;
      assertions.push({
        kind: "noFailedActions",
        passed,
        message: passed
          ? "no tool calls failed"
          : `${failures.length} tool call(s) failed: ${failures.map((f) => f.name).join(", ")}`,
        details: failures,
      });
    },
  };

  try {
    await definition.test(t);
  } catch (cause) {
    evalError = {
      name: cause instanceof Error ? cause.name : "EvalError",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    // Yield a microtask so any in-flight terminal events make it into
    // the ledger BEFORE we abort the consumer. Without this nudge,
    // events published during the last tool-dispatch can land in the
    // bus queue after we've already aborted.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Signal the events consumer to stop — it races the abort against
    // the next iterator.next() so it exits cleanly even if the
    // underlying iterator wouldn't naturally complete.
    eventsAbort.abort();
    await eventsTask;
    // Tear down the app.
    await app.closeApp();
  }

  const allPassed = assertions.every((a) => a.passed) && evalError === undefined;
  return {
    description: definition.description,
    passed: allPassed,
    assertions,
    toolCalls,
    elapsedMs: Date.now() - started,
    ...(evalError ? { error: evalError } : {}),
  };
}

// ────────── Internal helpers ──────────

async function consumeEvents<P>(
  app: AppHarnessProtocol<P>,
  ledger: ObservedToolCall[],
  signal: AbortSignal,
): Promise<void> {
  // Manual iterator + Promise.race against the abort signal so we
  // exit on abort even if the underlying iterator never naturally
  // completes (app.events() returns an open subscription).
  const iter = app.events(TOOL_DISPATCH_FILTER)[Symbol.asyncIterator]();

  // Per-opId scratch keyed by the operation envelope's opId.
  //   requested envelope carries DispatchInput as payload → we stash
  //     {name, input} on first sight
  //   terminal envelope carries DispatchResult under payload.result →
  //     we combine with the stashed input + outcome to produce the
  //     final ObservedToolCall and push to the ledger
  // The two are correlated by opId. If a `requested` is missed (e.g.
  // late-attached subscriber, replayed terminal), we still emit a
  // best-effort record using the result.name with `input: undefined`.
  const pending = new Map<string, { name: string; input: unknown }>();

  const abortPromise = new Promise<{ aborted: true }>((resolve) => {
    if (signal.aborted) resolve({ aborted: true });
    else signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
  });
  try {
    while (true) {
      const nextPromise = iter.next();
      const result = await Promise.race([nextPromise, abortPromise]);
      if ("aborted" in result) {
        if (iter.return) await iter.return(undefined).catch(() => undefined);
        return;
      }
      if (result.done) return;
      processDispatchEvent(result.value, pending, ledger);
    }
  } catch {
    // Best-effort — the ledger already has whatever we observed.
  }
}

function processDispatchEvent(
  event: ProtocolEvent,
  pending: Map<string, { name: string; input: unknown }>,
  ledger: ObservedToolCall[],
): void {
  const opId = event.opId;
  if (!opId) return;

  if (event.phase === "requested") {
    // requested.payload IS the DispatchInput — see BaseHarness's
    // makeEvent path which now stamps op.input as the requested
    // envelope's payload. We pluck name + input and stash.
    const payload = event.payload as
      | { readonly name?: unknown; readonly input?: unknown }
      | undefined;
    if (payload && typeof payload.name === "string") {
      pending.set(opId, { name: payload.name, input: payload.input });
    }
    return;
  }

  if (event.phase !== "terminal") return;

  const stashed = pending.get(opId);
  pending.delete(opId);

  // terminal payload for tool:command:dispatch is { result: DispatchResult }.
  // DispatchResult carries {toolCallId, name, succeeded, content, ...}.
  const termPayload = event.payload as { readonly result?: unknown } | undefined;
  const dispatchResult = termPayload?.result as
    | { readonly name?: unknown; readonly content?: unknown; readonly succeeded?: unknown }
    | undefined;

  const name =
    stashed?.name ?? (typeof dispatchResult?.name === "string" ? dispatchResult.name : undefined);
  if (!name) return; // can't classify this call; drop silently

  const outcome: "succeeded" | "failed" = event.outcome === "failed" ? "failed" : "succeeded";

  const observed: ObservedToolCall = {
    name,
    input: stashed?.input,
    outcome,
    result: outcome === "succeeded" ? dispatchResult : undefined,
    ...(outcome === "failed" && event.error
      ? {
          error: {
            name: event.error.name ?? "Error",
            message: event.error.message ?? "unknown",
          },
        }
      : {}),
    at: event.timestamp ?? Date.now(),
  };
  ledger.push(observed);
}

function formatExpected(opts: { input?: unknown; isError?: boolean } | undefined): string {
  if (!opts) return "";
  const parts: string[] = [];
  if (opts.input !== undefined) parts.push(`input=${JSON.stringify(opts.input)}`);
  if (opts.isError !== undefined) parts.push(`isError=${opts.isError}`);
  return parts.length > 0 ? ` with ${parts.join(", ")}` : "";
}
