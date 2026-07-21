/**
 * `BaseHarness.commandStream` — the STREAMING command substrate primitive
 * (Phase 1A of the model-harness command-ification).
 *
 * `commandStream` fuses three things `command` and `runHarnessStream` each
 * half-provide:
 *
 *   1. `command`'s registry registration — mints the boundary hooks
 *      `onBefore<Verb>` / `onAfter<Verb>` (ADR 80) + makes the verb
 *      inbox-addressable.
 *   2. `runOperation`'s ONE interceptor cascade wrapping the body — guard →
 *      onBefore(input) → body → onAfter(R). NO second interceptor path.
 *   3. `runHarnessStream`'s async-iterator machinery — the body emits chunks
 *      to a sink and returns the final `R`; the cascade fires at the stream's
 *      START (guard/onBefore) and TERMINAL (onAfter over R).
 *
 * Phase 1A endows BOUNDARY hooks + the iterator ONLY — per-chunk interception
 * is Phase 2 (deliberately absent). These tests are the conformance for the
 * primitive: hook minting, boundary firing + ordering, guard-vetoes-before-
 * any-chunk, the async-iterator contract, abort/kill mid-stream, the registry
 * `run` drain path, transform-over-input/output, and zero-overhead.
 *
 * Mirrors `command-registry.spec.ts` / `command-hooks.spec.ts` — the minting +
 * firing patterns for the non-streaming twin.
 */

import { describe, expect, it } from "vitest";
import { Effect, Either, Stream } from "effect";
import { waitFor } from "@agentick/utils-next/testing";
import { HandlerError } from "@agentick/spec-next";
import type {
  MessageEnvelope,
  MessageHandlerError,
  OperationOrigin,
  ProtocolEvent,
  SubstrateError,
} from "@agentick/spec-next";
import {
  BaseHarness,
  deriveHookNames,
  OperationOutcomeError,
  type AsyncStream,
  type CommandHooks,
} from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

// Contribute a streaming test verb so the mapped `CommandHooks` mints typed
// `onBeforeModelGenerateStream` / `onAfterModelGenerateStream` — the type-level
// twin of `deriveHookNames("model:command:generate_stream")` (note `_` is a
// word boundary in `Pascal`).
interface GenInput {
  readonly tokens: readonly string[];
  /** When set, the body parks on `Effect.never` after the last chunk — the
   *  abort/kill-mid-stream fixture. */
  readonly hang?: boolean;
}
type GenChunk = string;
type GenResult = string;

declare module "../substrate/base-harness.js" {
  interface CommandRegistry {
    "model:generate_stream": { input: GenInput; output: GenResult };
  }
}

class StreamTestHarness extends BaseHarness<"model"> {
  /** Public streaming face (`.stream` — commandStream path, auto opId, sessionId scope). */
  readonly generate: (
    input: GenInput,
    opts?: { readonly origin?: OperationOrigin },
  ) => AsyncStream<GenChunk, GenResult>;

  /**
   * The Effect-native sink-fold twin (`.fx`) — the SAME cascade-wrapped op the
   * `.stream` face drives, composed in the caller's fiber. Phase 1B: this is the
   * form the loop's model call consumes, so it MUST fire the same boundary hooks
   * + guard.
   */
  readonly generateFx: (
    input: GenInput,
    sink: (chunk: GenChunk) => Effect.Effect<void>,
    opts?: { readonly origin?: OperationOrigin },
  ) => Effect.Effect<GenResult, SubstrateError, never>;

  /** In-fiber execution trace: `chunk:<t>` per sink, plus whatever hooks push. */
  readonly trace: string[] = [];
  /** Set true once the body reaches its `Effect.never` park (hang mode). */
  reachedHang = false;
  /** Set true if the parked body is interrupted (abort/kill path). */
  interrupted = false;

  constructor(
    scopeId: string,
    journal: MemoryJournal,
    bus: LocalEventBus,
    inbox: LocalInbox,
    opts: { readonly hooks?: CommandHooks } = {},
  ) {
    super("model", scopeId, journal, bus, inbox, {});
    if (opts.hooks) this.hook(opts.hooks);
    const cmd = this.commandStream<GenInput, GenChunk, GenResult, never>({
      name: "model:generate_stream",
      description: "stream tokens, return the concatenation",
      scope: () => ({ sessionId: this.scopeId }),
      body: (input, sink) =>
        Effect.gen(this, function* () {
          for (const t of input.tokens) {
            this.trace.push(`chunk:${t}`);
            yield* sink(t);
          }
          if (input.hang) {
            this.reachedHang = true;
            yield* Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  this.interrupted = true;
                }),
              ),
            );
          }
          return input.tokens.join("");
        }),
    });
    this.generate = cmd.stream;
    this.generateFx = cmd.fx;
  }

  /** Declaring a second stream under the SAME verb → duplicate error. */
  declareDuplicate(): void {
    this.commandStream({
      name: "model:generate_stream",
      body: (_i, _sink) => Effect.succeed("dup"),
    });
  }

  /** Declaring under a foreign surface prefix → prefix error. */
  declareForeignSurface(): void {
    this.commandStream({
      name: "tool:generate_stream",
      body: (_i, _sink) => Effect.succeed("foreign"),
    });
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: new Error(`unknown: ${msg.type}`) }));
  }
}

async function mkHarness(
  opts: { readonly hooks?: CommandHooks; readonly scopeId?: string } = {},
): Promise<{ h: StreamTestHarness; bus: LocalEventBus; inbox: LocalInbox }> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus({ batch: {} });
  const inbox = new LocalInbox();
  const h = new StreamTestHarness(opts.scopeId ?? "m1", journal, bus, inbox, {
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  });
  await h.ready;
  return { h, bus, inbox };
}

/** Passive collector — every event on the bus, until `stop()`. */
function collectAll(bus: LocalEventBus): { events: ProtocolEvent[] } {
  const events: ProtocolEvent[] = [];
  Effect.runFork(
    Stream.runForEach(bus.subscribe({}), (e) => Effect.sync(() => void events.push(e))),
  );
  return { events };
}

/** Drain a stream to an ordered chunk array. */
async function drain<C, R>(stream: AsyncStream<C, R>): Promise<C[]> {
  const chunks: C[] = [];
  for await (const c of stream) chunks.push(c);
  return chunks;
}

// ────────────────────────────────────────────────────────────────────────────
// Hook minting (ADR 80)
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — hook minting (ADR 80)", () => {
  it("mints onBefore/AfterModelGenerateStream (deriveHookNames lock + typed CommandHooks)", () => {
    // The runtime derivation splits on `_` too (snake word), matching the
    // type-level `Pascal`: `model:command:generate_stream` → ModelGenerateStream.
    const names = deriveHookNames("model:command:generate_stream");
    expect(names).toEqual(["onBeforeModelGenerateStream", "onAfterModelGenerateStream"]);
    // `_typed` compiles ONLY because the mapped `CommandHooks` minted exactly
    // these keys for the `"model:generate_stream"` registry entry — type and
    // runtime agree.
    const _typed: CommandHooks = {
      onBeforeModelGenerateStream: (i) => i,
      onAfterModelGenerateStream: (o) => o,
    };
    expect(Object.keys(_typed).sort()).toEqual([...names].sort());
  });

  it("the minted before-hook fires on the stream (registrar exists + observes input)", async () => {
    const { h } = await mkHarness();
    let seen: GenInput | undefined;
    h.hooks.onBeforeModelGenerateStream((input) => {
      seen = input;
    });
    await drain(h.generate({ tokens: ["a", "b"] }));
    expect(seen?.tokens).toEqual(["a", "b"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Boundary hooks fire (before → chunks → after → terminal)
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — boundary hooks (before → chunks → after → terminal)", () => {
  it("onBefore fires before the first chunk; onAfter fires after the last chunk", async () => {
    const { h } = await mkHarness();
    h.hook({
      onBeforeModelGenerateStream: (i) => {
        h.trace.push("before");
        return i;
      },
      onAfterModelGenerateStream: (o) => {
        h.trace.push("after");
        return o;
      },
    });
    const stream = h.generate({ tokens: ["a", "b"] });
    const chunks = await drain(stream);
    const result = await stream.result;

    expect(chunks).toEqual(["a", "b"]);
    expect(result).toBe("ab");
    // In-fiber ordering: guard/onBefore bracket the first chunk; onAfter the last.
    expect(h.trace).toEqual(["before", "chunk:a", "chunk:b", "after"]);
  });

  it("the terminal event fires exactly once carrying the final R", async () => {
    const { h, bus } = await mkHarness();
    const { events } = collectAll(bus);

    const stream = h.generate({ tokens: ["x", "y", "z"] });
    const result = await stream.result;
    await drain(stream); // ensure the run is fully observed
    await waitFor(() =>
      events.some((e) => e.name === "model:command:generate_stream" && e.phase === "terminal"),
    );

    const terminals = events.filter(
      (e) => e.name === "model:command:generate_stream" && e.phase === "terminal",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.outcome).toBe("succeeded");
    expect((terminals[0]?.payload as { result?: unknown } | undefined)?.result).toBe(result);
    expect(result).toBe("xyz");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The `.fx` sink-fold twin fires the SAME cascade (Phase 1B)
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — the .fx sink-fold twin (Phase 1B)", () => {
  it("fx(input, sink) fires the SAME boundary hooks + forwards chunks to the sink", async () => {
    const { h } = await mkHarness();
    h.hook({
      onBeforeModelGenerateStream: (i) => {
        h.trace.push("before");
        return i;
      },
      onAfterModelGenerateStream: (o) => {
        h.trace.push("after");
        return o;
      },
    });
    const forwarded: GenChunk[] = [];
    // Compose the twin in-fiber (the loop's shape) — no Queue/iterator bridge.
    const result = await Effect.runPromise(
      h.generateFx({ tokens: ["a", "b"] }, (c) => Effect.sync(() => forwarded.push(c))),
    );
    expect(result).toBe("ab");
    expect(forwarded).toEqual(["a", "b"]);
    // The cascade wraps the twin identically to the stream face: before → chunks
    // → after (the boundary hooks fired, proving the model call gets them).
    expect(h.trace).toEqual(["before", "chunk:a", "chunk:b", "after"]);
  });

  it("a guard veto on the harness rejects the fx twin before the body runs", async () => {
    const { h } = await mkHarness();
    h.guard(() => ({ kind: "veto", reason: "locked" }));
    const forwarded: GenChunk[] = [];
    // The veto lands on the Effect failure channel (guards compose outermost).
    // `Effect.either` surfaces the raw error un-wrapped (a standalone
    // `runPromise` would box it in a FiberFailure).
    const outcome = await Effect.runPromise(
      Effect.either(
        h.generateFx({ tokens: ["a", "b"] }, (c) => Effect.sync(() => forwarded.push(c))),
      ),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toBeInstanceOf(OperationOutcomeError);
      expect((outcome.left as OperationOutcomeError).outcome).toBe("vetoed");
    }
    // No chunk reached the sink; the body never ran.
    expect(forwarded).toEqual([]);
    expect(h.trace).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Guard vetoes before any chunk
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — guard vetoes before any chunk", () => {
  it("a veto yields NO chunks, .result rejects with OperationOutcomeError(vetoed), body never runs", async () => {
    const { h } = await mkHarness();
    // Guards compose outermost — deny before any transform or body.
    h.guard(() => ({ kind: "veto", reason: "locked" }));

    const stream = h.generate({ tokens: ["a", "b"] });

    // Iteration throws the veto after yielding zero chunks.
    const chunks: GenChunk[] = [];
    let thrown: unknown;
    try {
      for await (const c of stream) chunks.push(c);
    } catch (err) {
      thrown = err;
    }
    expect(chunks).toEqual([]);
    expect(thrown).toBeInstanceOf(OperationOutcomeError);
    expect((thrown as OperationOutcomeError).outcome).toBe("vetoed");

    // `.result` carries the same veto.
    await expect(stream.result).rejects.toBeInstanceOf(OperationOutcomeError);
    // The body never ran — no chunk marker was pushed.
    expect(h.trace).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Async-iterator contract
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — async-iterator contract", () => {
  it("for-await yields every chunk in order and .result === the body's R (one run)", async () => {
    const { h } = await mkHarness();
    const stream = h.generate({ tokens: ["h", "e", "l", "l", "o"] });
    const chunks = await drain(stream);
    const result = await stream.result;
    expect(chunks).toEqual(["h", "e", "l", "l", "o"]);
    expect(result).toBe("hello");
    // ONE underlying run — the body sank each token exactly once.
    expect(h.trace).toEqual(["chunk:h", "chunk:e", "chunk:l", "chunk:l", "chunk:o"]);
  });

  it("awaiting .result before iterating still yields the chunks (same outcome, one run)", async () => {
    const { h } = await mkHarness();
    const stream = h.generate({ tokens: ["p", "q"] });
    const result = await stream.result;
    const chunks = await drain(stream);
    expect(result).toBe("pq");
    expect(chunks).toEqual(["p", "q"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Abort / kill mid-stream (the kill/resume-critical case)
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — abort / kill mid-stream", () => {
  it("abort interrupts the fiber; .result rejects; no onAfter / terminal:succeeded fires", async () => {
    const { h, bus } = await mkHarness();
    let afterFired = false;
    h.hook({
      onAfterModelGenerateStream: (o) => {
        afterFired = true;
        return o;
      },
    });
    const { events } = collectAll(bus);

    const stream = h.generate({ tokens: ["a", "b"], hang: true });
    const it = stream[Symbol.asyncIterator]();

    // Consume the two emitted chunks, then let the body park on Effect.never.
    expect(await it.next()).toEqual({ value: "a", done: false });
    expect(await it.next()).toEqual({ value: "b", done: false });
    await waitFor(() => h.reachedHang);

    // Kill mid-stream.
    stream.abort("cancel");
    await waitFor(() => h.interrupted);

    // `.result` rejects (interrupted cause — not a bogus success).
    await expect(stream.result).rejects.toBeTruthy();
    // No onAfter fired with a bogus value; no terminal:succeeded was published.
    expect(afterFired).toBe(false);
    const succeeded = events.filter(
      (e) =>
        e.name === "model:command:generate_stream" &&
        e.phase === "terminal" &&
        e.outcome === "succeeded",
    );
    expect(succeeded).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Inbox / registry `run` drain path
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — inbox/registry run (drain to R)", () => {
  it("invoking the declared verb via the inbox drains to R + fires boundary hooks once", async () => {
    let beforeCount = 0;
    let afterCount = 0;
    const { h, inbox } = await mkHarness({
      hooks: {
        onBeforeModelGenerateStream: (i) => {
          beforeCount++;
          return i;
        },
        onAfterModelGenerateStream: (o) => {
          afterCount++;
          return o;
        },
      },
    });

    // The registry `run` uses a no-op sink — a remote/inbox caller gets the
    // final R, not a stream.
    const result = await Effect.runPromise(
      inbox.ask<GenInput, GenResult>("model:m1", {
        type: "model:generate_stream",
        payload: { tokens: ["r", "u", "n"] },
      }),
    );
    expect(result).toBe("run");
    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
    // The body still sank each token (drained internally, dropped by the no-op sink).
    expect(h.trace).toEqual(["chunk:r", "chunk:u", "chunk:n"]);
    await h.close();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Transform interceptor over input/output (ADR 83)
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — transform over input/output (ADR 83)", () => {
  it("onBefore reshapes what the body sees; onAfter reshapes R — the cascade wraps the body", async () => {
    const { h } = await mkHarness({
      hooks: {
        // Reshape the input the body iterates: uppercase every token.
        onBeforeModelGenerateStream: (i) => ({ tokens: i.tokens.map((t) => t.toUpperCase()) }),
        // Reshape the output R the run resolves to.
        onAfterModelGenerateStream: (o) => `${o}!`,
      },
    });
    const stream = h.generate({ tokens: ["a", "b"] });
    const chunks = await drain(stream);
    const result = await stream.result;
    // Body saw the reshaped input → the chunks are uppercase.
    expect(chunks).toEqual(["A", "B"]);
    // onAfter reshaped R.
    expect(result).toBe("AB!");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Zero-overhead (no interceptors)
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — zero-overhead (no interceptors)", () => {
  it("with no interceptors registered the stream yields + resolves cleanly", async () => {
    const { h } = await mkHarness();
    const stream = h.generate({ tokens: ["1", "2", "3"] });
    const chunks = await drain(stream);
    await expect(stream.result).resolves.toBe("123");
    expect(chunks).toEqual(["1", "2", "3"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Registry registration IDENTICAL to `command` (declaration errors)
// ────────────────────────────────────────────────────────────────────────────

describe("commandStream — declaration (registry registration identical to command)", () => {
  it("throws CommandDeclarationError on a duplicate verb", async () => {
    const { h } = await mkHarness();
    expect(() => h.declareDuplicate()).toThrow(/duplicate declaration/);
  });

  it("throws CommandDeclarationError on a foreign surface prefix", async () => {
    const { h } = await mkHarness();
    expect(() => h.declareForeignSurface()).toThrow(/verb prefix must match/);
  });

  it("enumerates as a wire-safe command summary via commands()", async () => {
    const { h } = await mkHarness();
    expect(h.commands()).toEqual([
      {
        name: "model:generate_stream",
        exposure: "addressable",
        hasInput: false,
        description: "stream tokens, return the concatenation",
      },
    ]);
  });
});
