/**
 * BaseHarness command registry — the harness invocation model (ADR 51
 * §2). `this.command()` is the single declaration site for a verb; the
 * declaration IS the registration.
 *
 * Proves:
 *   1. The returned public method runs through `runOperation` with the
 *      canonical naming derived from the ONE verb string
 *      (`tool:echo` → op name `tool:command:echo`, opId prefix
 *      `tool:echo:`), and stamps `origin: "host"` by default.
 *   2. Declared verbs are inbox-addressable with zero `handleMessage`
 *      code — `ask` replies with the handler's result via the existing
 *      inbox contract; the operation's scope carries `origin: "inbox"`
 *      (or the delivering gate's stamp, e.g. `"wire"`).
 *   3. Validation happens ONCE, at dispatch, against the declared
 *      Standard Schema — a bad payload fails the asker with the
 *      existing typed `InvalidPayload`, and no operation runs.
 *   4. `exposure: "internal"` verbs are NOT addressable (fallthrough to
 *      `handleMessage`).
 *   5. `commands()` + the `"<surface>:commands"` meta-verb enumerate
 *      wire-safe summaries (declare-and-discover, ADR 51 §2.4).
 *   6. Mis-declarations throw `CommandDeclarationError` at
 *      construction (duplicate verb; foreign surface prefix).
 *   7. The dispatch precedence chain is preserved: an `onMessage`
 *      handler for the same type shadows the declared command.
 *
 * @see docs/proposals/v2/blueprint/51-invocation-and-authorization.md
 */

import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type {
  CommandInfo,
  MessageEnvelope,
  MessageHandlerError,
  ProtocolEvent,
  StandardSchemaV1,
} from "@agentick/spec-next";
import { CommandDeclarationError, HandlerError, InvalidPayload } from "@agentick/spec-next";
import { BaseHarness } from "../substrate/base-harness.js";
import { LocalEventBus } from "../substrate/local-event-bus.js";
import { LocalInbox } from "../substrate/local-inbox.js";
import { MemoryJournal } from "../substrate/memory-journal.js";

interface EchoInput {
  readonly text: string;
}

/** Minimal in-test Standard Schema (no schema lib dep in runtime). */
const echoSchema: StandardSchemaV1<EchoInput> = {
  "~standard": {
    version: 1,
    vendor: "command-registry-spec",
    validate: (value) =>
      typeof (value as EchoInput | undefined)?.text === "string"
        ? { value: value as EchoInput }
        : { issues: [{ message: "text must be a string" }] },
  },
};

class CommandTestHarness extends BaseHarness<"tool"> {
  readonly echo: (input: EchoInput, opts?: { origin?: "host" | "tree" }) => Promise<string>;
  readonly hidden: (input: undefined) => Promise<string>;

  constructor(scopeId: string, journal: MemoryJournal, bus: LocalEventBus, inbox: LocalInbox) {
    super("tool", scopeId, journal, bus, inbox);
    this.echo = this.command({
      name: "tool:echo",
      input: echoSchema,
      description: "echo the text back",
      scope: () => ({ sessionId: this.scopeId }),
      handler: (input) => Effect.succeed(`echo:${input.text}`),
    });
    this.hidden = this.command({
      name: "tool:hidden",
      exposure: "internal",
      handler: () => Effect.succeed("secret"),
    });
  }

  declareDuplicateEcho(): void {
    this.command({ name: "tool:echo", handler: () => Effect.void });
  }

  declareForeignSurface(): void {
    this.command({ name: "timeline:compact", handler: () => Effect.void });
  }

  protected handleMessage(
    msg: MessageEnvelope,
  ): Effect.Effect<unknown, MessageHandlerError, never> {
    return Effect.fail(new HandlerError({ cause: `unhandled message type: ${msg.type}` }));
  }
}

function fixture() {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus({ batch: {} });
  const inbox = new LocalInbox();
  const harness = new CommandTestHarness("t1", journal, bus, inbox);
  return { journal, bus, inbox, harness };
}

/** Collect the next `count` bus events matching `name`. */
function collectEvents(
  bus: LocalEventBus,
  count: number,
): { events: ProtocolEvent[]; done: Promise<void> } {
  const events: ProtocolEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  Effect.runFork(
    Stream.runForEach(bus.subscribe({}), (e) =>
      Effect.sync(() => {
        events.push(e);
        if (events.length >= count) resolve();
      }),
    ),
  );
  return { events, done };
}

describe("BaseHarness.command — declaration + public method", () => {
  it("runs through runOperation with canonical naming and origin: host", async () => {
    const { bus, harness } = fixture();
    await harness.ready;
    const { events, done } = collectEvents(bus, 2);

    await expect(harness.echo({ text: "a" })).resolves.toBe("echo:a");
    await done;

    const requested = events.find((e) => e.phase === "requested");
    expect(requested?.name).toBe("tool:command:echo");
    expect(requested?.opId?.startsWith("tool:echo:")).toBe(true);
    expect(requested?.scope.origin).toBe("host");
    expect(requested?.scope.sessionId).toBe("t1");
    await harness.close();
  });

  it("honors an explicit gate origin on the public method", async () => {
    const { bus, harness } = fixture();
    await harness.ready;
    const { events, done } = collectEvents(bus, 2);

    await harness.echo({ text: "b" }, { origin: "tree" });
    await done;

    expect(events.find((e) => e.phase === "requested")?.scope.origin).toBe("tree");
    await harness.close();
  });

  it("throws CommandDeclarationError on a duplicate verb", async () => {
    const { harness } = fixture();
    await harness.ready;
    expect(() => harness.declareDuplicateEcho()).toThrow(CommandDeclarationError);
    await harness.close();
  });

  it("throws CommandDeclarationError on a foreign surface prefix", async () => {
    const { harness } = fixture();
    await harness.ready;
    expect(() => harness.declareForeignSurface()).toThrow(CommandDeclarationError);
    await harness.close();
  });
});

describe("BaseHarness.command — inbox addressability (zero handleMessage code)", () => {
  it("ask routes to the declared handler and replies with its result", async () => {
    const { inbox, harness } = fixture();
    await harness.ready;

    const result = await Effect.runPromise(
      inbox.ask<EchoInput, string>("tool:t1", { type: "tool:echo", payload: { text: "c" } }),
    );
    expect(result).toBe("echo:c");
    await harness.close();
  });

  it("stamps origin: inbox by default; honors the delivering gate's stamp", async () => {
    const { bus, inbox, harness } = fixture();
    await harness.ready;
    const { events, done } = collectEvents(bus, 4);

    await Effect.runPromise(inbox.ask("tool:t1", { type: "tool:echo", payload: { text: "d" } }));
    await Effect.runPromise(
      inbox.ask("tool:t1", { type: "tool:echo", payload: { text: "e" }, origin: "wire" }),
    );
    await done;

    const requested = events.filter((e) => e.phase === "requested");
    expect(requested[0]?.scope.origin).toBe("inbox");
    expect(requested[1]?.scope.origin).toBe("wire");
    await harness.close();
  });

  it("threads envelope causality (parentOpId) onto the operation", async () => {
    const { bus, inbox, harness } = fixture();
    await harness.ready;
    const { events, done } = collectEvents(bus, 2);

    await Effect.runPromise(
      inbox.ask("tool:t1", {
        type: "tool:echo",
        payload: { text: "f" },
        parentOpId: "op-parent-1",
      }),
    );
    await done;

    // correlationId rides RuntimeContext only (not the event envelope);
    // parentOpId is the envelope-observable causality dimension.
    expect(events.find((e) => e.phase === "requested")?.parentOpId).toBe("op-parent-1");
    await harness.close();
  });

  it("rejects a bad payload with typed InvalidPayload — and runs no operation", async () => {
    const { bus, inbox, harness } = fixture();
    await harness.ready;
    const seen: ProtocolEvent[] = [];
    Effect.runFork(
      Stream.runForEach(bus.subscribe({}), (e) => Effect.sync(() => void seen.push(e))),
    );

    const exit = await Effect.runPromiseExit(
      inbox.ask("tool:t1", { type: "tool:echo", payload: { text: 42 } }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(err).toBeInstanceOf(InvalidPayload);
      expect((err as InvalidPayload).reason).toContain('command "tool:echo"');
    }
    expect(seen.filter((e) => e.name === "tool:command:echo")).toHaveLength(0);
    await harness.close();
  });

  it("does NOT address exposure: internal verbs (fallthrough to handleMessage)", async () => {
    const { inbox, harness } = fixture();
    await harness.ready;

    const exit = await Effect.runPromiseExit(inbox.ask("tool:t1", { type: "tool:hidden" }));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const err = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(err).toBeInstanceOf(HandlerError);
    }
    // The internal verb still works as a plain in-process method.
    await expect(harness.hidden(undefined)).resolves.toBe("secret");
    await harness.close();
  });

  it("preserves the precedence chain — onMessage shadows a declared command", async () => {
    const { inbox, harness } = fixture();
    await harness.ready;

    const unsub = harness.onMessage("tool:echo", () => Effect.succeed("shadowed"));
    const shadowed = await Effect.runPromise(
      inbox.ask("tool:t1", { type: "tool:echo", payload: { text: "g" } }),
    );
    expect(shadowed).toBe("shadowed");

    unsub();
    const restored = await Effect.runPromise(
      inbox.ask("tool:t1", { type: "tool:echo", payload: { text: "g" } }),
    );
    expect(restored).toBe("echo:g");
    await harness.close();
  });
});

describe("BaseHarness.command — declare-and-discover", () => {
  it("commands() enumerates wire-safe summaries", async () => {
    const { harness } = fixture();
    await harness.ready;

    expect(harness.commands()).toEqual([
      {
        name: "tool:echo",
        exposure: "addressable",
        hasInput: true,
        description: "echo the text back",
      },
      { name: "tool:hidden", exposure: "internal", hasInput: false },
    ]);
    await harness.close();
  });

  it("serves the <surface>:commands meta-verb to remote callers", async () => {
    const { inbox, harness } = fixture();
    await harness.ready;

    const infos = await Effect.runPromise(
      inbox.ask<undefined, readonly CommandInfo[]>("tool:t1", { type: "tool:commands" }),
    );
    expect(infos.map((i) => i.name)).toEqual(["tool:echo", "tool:hidden"]);
    await harness.close();
  });
});
