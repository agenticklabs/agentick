/**
 * CommandRunner (A2.4) — the command subsystem as a standalone instance,
 * tested in ISOLATION against a FAKE `runOperation`.
 *
 * This is the isolation win the extraction buys: the command-declaration layer
 * (prefix rule, duplicate rule, opId derivation, descriptor shape, the ONE
 * shared Operation manufacture, the chunk-interceptor compose order, and the
 * three stream faces) is provable WITHOUT journal / bus / interceptor-cascade /
 * inbox machinery. The fake executor just captures the manufactured
 * {@link Operation} and runs the body — no phase contract, no idempotency, no
 * `withContext`.
 *
 * The end-to-end behavior (journaling, idempotency replay, the interceptor
 * cascade, inbox addressability) stays covered by `command-registry.spec.ts` and
 * `command-stream.spec.ts`, which drive a real {@link BaseHarness}.
 *
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 * @see docs/proposals/v2/STATUS.md — ROADMAP A2.4
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ChunkInterceptor, Operation, StandardSchemaV1 } from "@agentick/spec";
import { CommandDeclarationError, deriveChunkHookName } from "@agentick/spec";
import { createCommandRunner, type CommandRunner } from "../substrate/command-runner.js";
import type { RunOperation } from "../substrate/operation-runner.js";
import type { RuntimeContext } from "../substrate/runtime-context.js";

interface EchoInput {
  readonly text: string;
}

/** Minimal in-test Standard Schema (no schema lib dep in runtime). */
const echoSchema: StandardSchemaV1<EchoInput> = {
  "~standard": {
    version: 1,
    vendor: "command-runner-spec",
    validate: (value) =>
      typeof (value as EchoInput | undefined)?.text === "string"
        ? { value: value as EchoInput }
        : { issues: [{ message: "text must be a string" }] },
  },
};

/**
 * A fake {@link RunOperation} that captures every manufactured Operation and
 * runs the body verbatim (no phase contract / journaling / context scope). The
 * captured `ops` list is the assertion surface for the manufacture logic.
 */
function fakeRunOperation(): {
  runOperation: RunOperation;
  ops: Operation<unknown, unknown, unknown>[];
} {
  const ops: Operation<unknown, unknown, unknown>[] = [];
  const runOperation: RunOperation = <I, R, E>(
    op: Operation<I, R, E>,
    body: (input: I) => Effect.Effect<R, E, never>,
  ) => {
    ops.push(op as Operation<unknown, unknown, unknown>);
    return body(op.input) as Effect.Effect<R, never, never>;
  };
  return { runOperation, ops };
}

function fixture(surface = "tool"): {
  runner: CommandRunner;
  ops: Operation<unknown, unknown, unknown>[];
} {
  const { runOperation, ops } = fakeRunOperation();
  return { runner: createCommandRunner({ surface, runOperation }), ops };
}

describe("CommandRunner — declaration rules", () => {
  it("rejects a verb whose prefix does not match the surface", () => {
    const { runner } = fixture();
    expect(() => runner.command({ name: "timeline:compact", handler: () => Effect.void })).toThrow(
      CommandDeclarationError,
    );
  });

  it("rejects a duplicate verb declaration", () => {
    const { runner } = fixture();
    runner.command({ name: "tool:echo", handler: () => Effect.succeed("a") });
    expect(() => runner.command({ name: "tool:echo", handler: () => Effect.succeed("b") })).toThrow(
      CommandDeclarationError,
    );
  });

  it("duplicate check spans command AND commandStream (one shared registry)", () => {
    const { runner } = fixture();
    runner.command({ name: "tool:x", handler: () => Effect.void });
    expect(() =>
      runner.commandStream({ name: "tool:x", body: (_i, _s) => Effect.succeed("r") }),
    ).toThrow(CommandDeclarationError);
  });
});

describe("CommandRunner — Operation manufacture", () => {
  it("derives the canonical op name + a fresh ulid opId, stamps origin: host", async () => {
    const { runner, ops } = fixture();
    const echo = runner.command<EchoInput, string, never>({
      name: "tool:echo",
      scope: (i) => ({ sessionId: `s-${i.text}` }),
      handler: (i) => Effect.succeed(`echo:${i.text}`),
    });

    await expect(echo({ text: "a" })).resolves.toBe("echo:a");
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.name).toBe("tool:command:echo");
    expect(op.surface).toBe("tool");
    expect(op.opId.startsWith("tool:echo:")).toBe(true);
    expect(op.scope?.origin).toBe("host");
    expect(op.scope?.sessionId).toBe("s-a");
    expect(op.input).toEqual({ text: "a" });
  });

  it("honors an explicit gate origin on the public method", async () => {
    const { runner, ops } = fixture();
    const echo = runner.command<EchoInput, string, never>({
      name: "tool:echo",
      handler: (i) => Effect.succeed(i.text),
    });
    await echo({ text: "b" }, { origin: "tree" });
    expect(ops[0]!.scope?.origin).toBe("tree");
  });

  it("uses def.opId for deterministic (idempotency) opId derivation", async () => {
    const { runner, ops } = fixture();
    const dispatch = runner.command<{ id: string }, string, never>({
      name: "tool:dispatch",
      opId: (i) => `tool:dispatch:${i.id}`,
      handler: () => Effect.succeed("ok"),
    });
    await dispatch({ id: "call-42" });
    await dispatch({ id: "call-42" });
    expect(ops.map((o) => o.opId)).toEqual(["tool:dispatch:call-42", "tool:dispatch:call-42"]);
  });
});

describe("CommandRunner — descriptor shape + listing", () => {
  it("commands() enumerates wire-safe summaries; get() resolves the registered entry", () => {
    const { runner } = fixture();
    runner.command({
      name: "tool:echo",
      input: echoSchema,
      description: "echo the text back",
      handler: () => Effect.succeed("x"),
    });
    runner.command({
      name: "tool:hidden",
      exposure: "internal",
      handler: () => Effect.succeed("s"),
    });

    expect(runner.commands()).toEqual([
      {
        name: "tool:echo",
        exposure: "addressable",
        hasInput: true,
        description: "echo the text back",
      },
      { name: "tool:hidden", exposure: "internal", hasInput: false },
    ]);
    expect(runner.get("tool:echo")?.descriptor.name).toBe("tool:echo");
    expect(runner.get("tool:missing")).toBeUndefined();
  });
});

describe("CommandRunner — commandEffect (intra-harness composition)", () => {
  it("invokes a declared command on the Effect channel", async () => {
    const { runner } = fixture();
    runner.command<EchoInput, string, never>({
      name: "tool:echo",
      handler: (i) => Effect.succeed(`fx:${i.text}`),
    });
    const out = await Effect.runPromise(
      runner.commandEffect<EchoInput, string, never>("tool:echo", { text: "c" }),
    );
    expect(out).toBe("fx:c");
  });

  it("throws CommandDeclarationError for an undeclared name", () => {
    const { runner } = fixture();
    expect(() => runner.commandEffect("tool:nope", undefined)).toThrow(CommandDeclarationError);
  });
});

describe("CommandRunner — commandStream three faces over ONE run", () => {
  const declareStream = (runner: CommandRunner) =>
    runner.commandStream<{ n: number }, string, string, never>({
      name: "tool:gen",
      body: (input, sink) =>
        Effect.gen(function* () {
          yield* sink("a");
          yield* sink("b");
          return `done:${input.n}`;
        }),
    });

  it("fx — the sink-fold twin drains chunks in-fiber and returns R", async () => {
    const { runner } = fixture();
    const cmd = declareStream(runner);
    const chunks: string[] = [];
    const result = await Effect.runPromise(
      cmd.fx({ n: 1 }, (c) => Effect.sync(() => void chunks.push(c))),
    );
    expect(chunks).toEqual(["a", "b"]);
    expect(result).toBe("done:1");
  });

  it("stream — the AsyncStream face drains the same chunks + result", async () => {
    const { runner } = fixture();
    const cmd = declareStream(runner);
    const s = cmd.stream({ n: 2 });
    const got: string[] = [];
    for await (const c of s) got.push(c);
    expect(got).toEqual(["a", "b"]);
    await expect(s.result).resolves.toBe("done:2");
  });

  it("run — the no-op-sink drain returns R (inbox/remote face)", async () => {
    const { runner } = fixture();
    const cmd = declareStream(runner);
    await expect(cmd.run({ n: 3 })).resolves.toBe("done:3");
  });
});

describe("CommandRunner — per-command chunk interceptor compose order", () => {
  it("declared interceptors compose closest to the body, before dynamic ones", async () => {
    const { runner } = fixture();
    const seen: string[] = [];
    const tap = (label: string): ChunkInterceptor<string, RuntimeContext> => ({
      observe: (chunk) => void seen.push(`${label}:${chunk}`),
    });

    const cmd = runner.commandStream<{ n: number }, string, string, never>({
      name: "tool:gen",
      chunk: [tap("declared")],
      body: (_input, sink) =>
        Effect.gen(function* () {
          yield* sink("x");
          return "r";
        }),
    });
    // Dynamic interceptor registered under the minted `on<Verb>Chunk` key
    // (`deriveChunkHookName("tool:command:gen")` === "onToolGenChunk").
    runner.registerChunkInterceptor(
      deriveChunkHookName("tool:command:gen"),
      tap("dynamic") as ChunkInterceptor<unknown, RuntimeContext>,
    );

    const out: string[] = [];
    await Effect.runPromise(cmd.fx({ n: 1 }, (c) => Effect.sync(() => void out.push(c))));

    // Body emits "x"; the pipeline runs declared FIRST (closest to the body),
    // then dynamic, then the real sink — chunk forwarded unchanged by observers.
    expect(seen).toEqual(["declared:x", "dynamic:x"]);
    expect(out).toEqual(["x"]);
  });

  it("registerChunkInterceptor returns an Unsubscribe that removes exactly that tap", async () => {
    const { runner } = fixture();
    const seen: string[] = [];
    const cmd = runner.commandStream<{ n: number }, string, string, never>({
      name: "tool:gen",
      body: (_input, sink) =>
        Effect.gen(function* () {
          yield* sink("x");
          return "r";
        }),
    });
    const off = runner.registerChunkInterceptor(deriveChunkHookName("tool:command:gen"), {
      observe: (chunk) => void seen.push(`d:${chunk as string}`),
    });
    off();

    await Effect.runPromise(cmd.fx({ n: 1 }, () => Effect.void));
    expect(seen).toEqual([]); // removed before the run — never taps
  });
});
