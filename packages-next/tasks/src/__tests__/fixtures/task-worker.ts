/**
 * Fixture worker module for the child-process executor tests (ADR 68
 * Build B). Forked by `ChildProcessTaskExecutor` under `tsx`; imports the
 * real worker runtime from the package (proving workspace resolution
 * works inside a forked child), registers the four canonical conformance
 * handlers, then hands control to `runTaskWorker`.
 *
 * This IS the adopter's `workerModule` pattern: register handlers → call
 * `runTaskWorker()`.
 */

import { registerTaskHandler, runTaskWorker } from "@agentick/tasks-next";
import type { ContentBlock } from "@agentick/spec-next";

// `echo` — returns its input as a text content block. Round-trip proof.
registerTaskHandler<unknown, readonly ContentBlock[]>("echo", (_ctx, input) => [
  { type: "text", text: String(input) },
]);

// `roundtrip` — echoes its `input` back as the result. With the executor's
// `serialization: "advanced"` default, a `Date` / `Map` / typed-array in the
// input must survive BOTH directions (parent→child input, child→parent
// result) with instances intact — the structured-clone claim, proven.
registerTaskHandler<unknown, unknown>("roundtrip", (_ctx, input) => input);

// `progress` — emits three ordered progress updates then completes.
registerTaskHandler<unknown, readonly ContentBlock[]>("progress", async (ctx) => {
  ctx.onProgress({ current: 1, total: 3 });
  ctx.onProgress({ current: 2, total: 3 });
  ctx.onProgress({ current: 3, total: 3 });
  return [{ type: "text", text: "progress-done" }];
});

// `thrower` — fails with a reason.
registerTaskHandler("thrower", () => {
  throw new Error("worker-boom");
});

// `slow` — runs until the abort signal fires (honors cancel).
registerTaskHandler<unknown, readonly ContentBlock[]>("slow", async (ctx) => {
  await new Promise<void>((_resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  return [{ type: "text", text: "should-not-reach" }];
});

// `awaits-input` — pauses on an EXTERNAL input via `ctx.awaitingInput`,
// released by a custom `{ t: "release-input" }` parent IPC message (a
// deferred-triggered release — deterministic, NOT a timer race). Proves
// the worker flips `input_required → working → completed` over IPC. The
// handler owns its own release protocol on top of the worker's IPC (the
// worker's own `process.on("message")` ignores non-start/cancel messages).
registerTaskHandler<unknown, readonly ContentBlock[]>("awaits-input", async (ctx) => {
  const released = new Promise<void>((resolve) => {
    const onMessage = (message: unknown): void => {
      if (
        message != null &&
        typeof message === "object" &&
        (message as { t?: string }).t === "release-input"
      ) {
        process.off("message", onMessage);
        resolve();
      }
    };
    process.on("message", onMessage);
  });
  await ctx.awaitingInput(released, { message: "need input" });
  return [{ type: "text", text: "input-provided" }];
});

// `hang` — ignores the signal and never resolves. Forces the SIGKILL
// backstop (the cooperative cancel can't stop it).
registerTaskHandler<unknown, readonly ContentBlock[]>("hang", async () => {
  await new Promise<void>(() => {
    /* never resolves, never observes the signal */
  });
  return [];
});

runTaskWorker();
