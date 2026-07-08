/**
 * Internal eval runner — drives one invocation of a `defineEval`-
 * returned callable to completion.
 *
 * Flow per invocation:
 *   1. Call `definition.app(overrides)` to construct a fresh app. The
 *      thunk owns option merging; the runner does none of its own.
 *   2. For each `t.send`, open a fresh session, iterate the send
 *      handle's event stream to observe tool calls (correlating
 *      `tool_call` → `tool_result` by call id), and await the result.
 *   3. Invoke `definition.test(t)`; assertions record into a ledger.
 *   4. Close sessions; return the aggregated {@link EvalResult}.
 *
 * Assertions don't throw — they record. Adopters who want fail-fast
 * check `result.passed` and decide whether to continue.
 */

import type {
  AssertionResult,
  EvalApp,
  EvalContext,
  EvalDefinition,
  EvalResult,
  EvalSendInput,
  EvalSession,
  ObservedToolCall,
} from "./types.js";

// ============================================================================
// Deep equality (no deps — small structural comparison)
// ============================================================================

function isEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    isEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

// ============================================================================
// Runner
// ============================================================================

export async function runEval<O>(
  definition: EvalDefinition<O>,
  overrides: O | undefined,
): Promise<EvalResult> {
  const started = Date.now();

  const app: EvalApp = await definition.app(overrides);

  const toolCalls: ObservedToolCall[] = [];
  const assertions: AssertionResult[] = [];
  const openSessions: EvalSession[] = [];
  let lastSendErrored = false;
  let lastSendCompleted = false;
  let evalError: { name: string; message: string } | undefined;

  const record = (a: AssertionResult) => assertions.push(a);

  const t: EvalContext = {
    app,

    async send(input: EvalSendInput) {
      const session = await app.session();
      openSessions.push(session);
      lastSendErrored = false;
      lastSendCompleted = false;

      const content = typeof input === "string" ? [{ type: "text", text: input }] : input;
      // session.send returns a thenable; the resolved handle carries the
      // event stream (`.events`) alongside `.result`.
      const handle = await session.send({ messages: [{ role: "user", content }] });

      // Observe the event stream when available: correlate tool_call →
      // tool_result by call id, collect final text. Fall back to just
      // awaiting the result for apps whose handles don't stream.
      let finalText = "";
      const pending = new Map<string, { name: string; input: unknown }>();

      if (handle.events) {
        for await (const ev of handle.events) {
          const type = ev.type as string;
          if (type === "tool_call") {
            const id = (ev.callId ?? ev.id) as string;
            pending.set(id, { name: ev.name as string, input: ev.input });
          } else if (type === "tool_result") {
            const id = (ev.callId ?? ev.id) as string;
            const call = pending.get(id);
            if (call) {
              pending.delete(id);
              toolCalls.push({
                name: call.name,
                input: call.input,
                outcome: ev.isError === true ? "failed" : "succeeded",
                result: ev.result ?? ev.content,
                at: Date.now(),
              });
            }
          } else if (type === "message" && ev.message) {
            const message = ev.message as {
              role?: string;
              content?: Array<Record<string, unknown>>;
            };
            if (message.role === "assistant" && Array.isArray(message.content)) {
              for (const block of message.content) {
                if (block.type === "text" && typeof block.text === "string") {
                  finalText = block.text;
                }
              }
            }
          } else if (type === "error") {
            lastSendErrored = true;
          }
        }
      }

      await handle.result;
      // Any tool_call that never saw a result still counts as observed.
      for (const [, call] of pending) {
        toolCalls.push({
          name: call.name,
          input: call.input,
          outcome: "succeeded",
          at: Date.now(),
        });
      }
      lastSendCompleted = !lastSendErrored;
      return finalText;
    },

    completed() {
      record({
        kind: "completed",
        passed: lastSendCompleted,
        message: lastSendCompleted
          ? "run completed"
          : lastSendErrored
            ? "run emitted an error event"
            : "no send has completed",
      });
    },

    calledTool(name, opts) {
      const matches = toolCalls.filter((c) => {
        if (c.name !== name) return false;
        if (opts?.input !== undefined && !isEqual(c.input, opts.input)) return false;
        if (opts?.isError === true && c.outcome !== "failed") return false;
        if (opts?.isError === false && c.outcome !== "succeeded") return false;
        return true;
      });
      record({
        kind: "calledTool",
        passed: matches.length > 0,
        message:
          matches.length > 0
            ? `tool "${name}" was called`
            : `tool "${name}" was not called${opts?.input !== undefined ? " with the expected input" : ""} (observed: ${
                toolCalls.map((c) => c.name).join(", ") || "none"
              })`,
        details: { name, observed: toolCalls.length },
      });
    },

    notCalledTool(name) {
      const called = toolCalls.some((c) => c.name === name);
      record({
        kind: "notCalledTool",
        passed: !called,
        message: called ? `tool "${name}" WAS called` : `tool "${name}" was not called`,
        details: { name },
      });
    },

    noFailedActions() {
      const failed = toolCalls.filter((c) => c.outcome === "failed");
      record({
        kind: "noFailedActions",
        passed: failed.length === 0,
        message:
          failed.length === 0
            ? "no failed tool calls"
            : `${failed.length} tool call(s) failed: ${failed.map((c) => c.name).join(", ")}`,
        details: failed,
      });
    },

    expect(name, passed, opts) {
      record({
        kind: "expect",
        name,
        passed,
        message: opts?.message ?? (passed ? `${name} passed` : `${name} failed`),
        details: opts?.details,
      });
    },

    lastToolCall(name) {
      for (let i = toolCalls.length - 1; i >= 0; i--) {
        if (toolCalls[i]!.name === name) return toolCalls[i];
      }
      return undefined;
    },
  };

  try {
    await definition.test(t);
  } catch (err) {
    const e = err as Error;
    evalError = { name: e?.name ?? "Error", message: e?.message ?? String(err) };
  } finally {
    for (const session of openSessions) {
      try {
        session.close();
      } catch {
        // closing is best-effort
      }
    }
  }

  const passed = evalError === undefined && assertions.every((a) => a.passed);
  return {
    description: definition.description,
    passed,
    assertions,
    toolCalls,
    elapsedMs: Date.now() - started,
    ...(evalError ? { error: evalError } : {}),
  };
}
