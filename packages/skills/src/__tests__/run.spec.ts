/**
 * `skills.run` — harness mechanics (three-audiences-plan §C, C-core).
 *
 * These are the DEPENDENCY-FREE tests: the send capability is a STUB (Meszaros
 * — canned answers) recording the composed `SendInput` and returning a scripted
 * handle. No session, no compiler, no model. They pin the harness's own logic:
 *
 *   - default composition (system-role skill body + user-role serialized args)
 *   - the `composeRun` seam override
 *   - handle pass-through (the run IS a send — one grammar; `data`/`response`
 *     arrive via `handle.result`, streaming via `handle.events()`)
 *   - `isolate: true` with NO isolation runner bound → `SkillIsolationUnavailable`
 *     (never silently degrade to a same-session run)
 *   - `isolate: true` WITH an isolation runner bound → routes through it (C2)
 *   - `Skill.allowedTools` threads into `SendInput.allowedTools` (C2)
 *   - missing skill → `SkillNotFound` propagates (via `require`)
 *   - no bound runner → `SkillRunnerUnbound` (not an undefined-crash)
 *
 * The real end-to-end path (a scripted terminal-tool call → validated `data`,
 * the steer-conflict reentrancy) lives in `@agentick/app`, where the
 * session + injection site are dependencies.
 *
 * @see docs/proposals/v2/three-audiences-plan.md §C
 */

import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import { waitFor } from "@agentick/utils/testing";
import type {
  MessageSource,
  ProtocolEvent,
  SendInput,
  SendResult,
  SessionExecutionHandle,
  SessionSendCapability,
} from "@agentick/spec";

import { SkillsHarness, type SkillsHarnessOptions } from "../harness.js";
import type { SkillRunCompose } from "../handle.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

/** A canned `SendResult` — the stub runner's answer. */
function mkSendResult(over: Partial<SendResult> = {}): SendResult {
  return {
    response: "assistant prose",
    output: [{ type: "text", text: "assistant prose" }],
    toolResults: [],
    usage,
    stopReason: "end",
    ticks: 1,
    executionId: "exec-1",
    ...over,
  };
}

/** A stub send capability: records each `SendInput`, returns a scripted handle
 *  whose `.result` resolves (or rejects) as configured. */
function stubRunner(opts: { readonly result?: SendResult; readonly reject?: unknown }): {
  readonly send: SessionSendCapability;
  readonly captured: SendInput[];
} {
  const captured: SendInput[] = [];
  const send: SessionSendCapability = async (input) => {
    captured.push(input);
    const handle: SessionExecutionHandle = {
      executionId: "exec-1",
      status: "completed",
      result:
        opts.reject !== undefined
          ? Promise.reject(opts.reject)
          : Promise.resolve(opts.result ?? mkSendResult()),
      events: async function* () {},
      readable: () => new ReadableStream(),
      pipeTo: async () => {},
      abort: async () => {},
    };
    // Prevent unhandled-rejection noise on the reject path (the test awaits it
    // through `run`).
    if (opts.reject !== undefined) void handle.result.catch(() => {});
    return handle;
  };
  return { send, captured };
}

async function mkHarness(options: SkillsHarnessOptions = {}): Promise<SkillsHarness> {
  const h = new SkillsHarness(
    `run:${generateId()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    options,
  );
  await h.ready;
  return h;
}

describe("skills.run — default composition", () => {
  it("system message carries the skill content; user message carries serialized args", async () => {
    const h = await mkHarness();
    await h.register({
      name: "review",
      description: "Review a change",
      content: "SKILL BODY HERE",
    });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await h.run("review", { args: { change: "diff-123" } });

    expect(captured).toHaveLength(1);
    const msgs = captured[0]!.messages!;
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("SKILL BODY HERE");
    expect(msgs[1]!.role).toBe("user");
    // Serialized args (JSON) ride the user turn.
    expect(msgs[1]!.content).toContain("diff-123");
    expect(msgs[1]!.content).toBe(JSON.stringify({ change: "diff-123" }, null, 2));
    await h.close();
  });

  it("args-free run: the user turn is an instruction, not JSON", async () => {
    const h = await mkHarness();
    await h.register({ name: "greet", description: "Greet", content: "Say hello." });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await h.run("greet");

    const msgs = captured[0]!.messages!;
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).not.toContain("{");
    await h.close();
  });

  it("threads output / maxTicks / signal through to the send", async () => {
    const h = await mkHarness();
    await h.register({ name: "s", description: "s", content: "body" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);
    const controller = new AbortController();
    const schema = {
      "~standard": { version: 1, vendor: "test", validate: (v: unknown) => ({ value: v }) },
    } as never;

    await h.run("s", { output: schema, maxTicks: 3, signal: controller.signal });

    expect(captured[0]!.output).toBe(schema);
    expect(captured[0]!.maxTicks).toBe(3);
    expect(captured[0]!.signal).toBe(controller.signal);
    await h.close();
  });
});

describe("skills.run — composeRun seam", () => {
  it("an override fully owns composition (the default is not used)", async () => {
    const compose: SkillRunCompose = (skill, opts) => ({
      messages: [{ role: "user", content: `custom:${skill.name}:${JSON.stringify(opts.args)}` }],
    });
    const h = new SkillsHarness(
      `run:${generateId()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { composeRun: compose },
    );
    await h.ready;
    await h.register({ name: "custom", description: "c", content: "IGNORED BODY" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await h.run("custom", { args: { a: 1 } });

    const msgs = captured[0]!.messages!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe('custom:custom:{"a":1}');
    // The default system-with-skill-body message is absent — the seam is the truth.
    expect(
      msgs.some((m) => typeof m.content === "string" && m.content.includes("IGNORED BODY")),
    ).toBe(false);
    await h.close();
  });
});

describe("skills.run — allowedTools (C2 per-execution tool restriction)", () => {
  it("Skill.allowedTools round-trips through register/get and threads into the send", async () => {
    const h = await mkHarness();
    await h.register({
      name: "scoped",
      description: "a scoped skill",
      content: "body",
      allowedTools: ["echo", "search"],
    });
    // Record plumbing: the field survives register → get.
    expect(h.get("scoped")?.allowedTools).toEqual(["echo", "search"]);

    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);
    await h.run("scoped");

    // compose-run threads the skill's allowlist into the send's restriction seam.
    expect(captured[0]!.allowedTools).toEqual(["echo", "search"]);
    await h.close();
  });

  it("a skill without allowedTools produces a send with no restriction", async () => {
    const h = await mkHarness();
    await h.register({ name: "open", description: "no restriction", content: "body" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);
    await h.run("open");
    expect("allowedTools" in captured[0]!).toBe(false);
    await h.close();
  });
});

describe("skills.run — handle pass-through (one grammar with send)", () => {
  it("with output: the handle's result carries typed data + response + stopReason + ids", async () => {
    const h = await mkHarness();
    await h.register({ name: "extract", description: "x", content: "body" });
    const { send } = stubRunner({
      result: mkSendResult({
        response: "here you go",
        data: { approved: true },
        stopReason: "output_delivered",
        ticks: 2,
        executionId: "exec-xyz",
      }),
    });
    h.bindRunner(send);

    const handle = await h.run<{ approved: boolean }>("extract", { output: {} as never });
    // The send grammar, verbatim: streaming + abort + status live on the handle
    // (the stub's handle id; the scripted RESULT carries its own).
    expect(handle.executionId).toBe("exec-1");
    expect(typeof handle.events).toBe("function");
    expect(typeof handle.abort).toBe("function");

    const r = await handle.result;
    expect(r.data).toEqual({ approved: true });
    expect(r.response).toBe("here you go");
    expect(r.stopReason).toBe("output_delivered");
    expect(r.ticks).toBe(2);
    expect(r.executionId).toBe("exec-xyz");
    expect(r.usage).toEqual(usage);
    await h.close();
  });

  it("without output: response is returned, data is absent", async () => {
    const h = await mkHarness();
    await h.register({ name: "chat", description: "x", content: "body" });
    const { send } = stubRunner({ result: mkSendResult({ response: "just text" }) });
    h.bindRunner(send);

    const r = await (await h.run("chat")).result;

    expect(r.response).toBe("just text");
    expect("data" in r).toBe(false);
    await h.close();
  });

  it("a send rejection (e.g. validation failure) surfaces on handle.result, not run()", async () => {
    const h = await mkHarness();
    await h.register({ name: "s", description: "x", content: "body" });
    const { send } = stubRunner({ reject: new Error("ResponseValidationError-ish") });
    h.bindRunner(send);

    // run() itself resolves — the handle is the contract; the typed failure
    // rides `.result`, exactly as it does for session.send.
    const handle = await h.run("s", { output: {} as never });
    await expect(handle.result).rejects.toThrow("ResponseValidationError-ish");
    await h.close();
  });
});

describe("skills.run — guards", () => {
  it("isolate: true with NO isolation runner bound → SkillIsolationUnavailable", async () => {
    const h = await mkHarness();
    await h.register({ name: "s", description: "x", content: "body" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    // Only the non-isolated runner is bound — no `bindIsolationRunner`.
    h.bindRunner(send);

    await expect(h.run("s", { isolate: true })).rejects.toMatchObject({
      _tag: "SkillIsolationUnavailable",
      skillName: "s",
    });
    // Never silently degrade to the same-session runner — it was not invoked.
    expect(captured).toHaveLength(0);
    await h.close();
  });

  it("isolate: true WITH an isolation runner bound → routes through it, NOT the plain runner", async () => {
    const h = await mkHarness();
    await h.register({ name: "s", description: "x", content: "body" });
    const plain = stubRunner({ result: mkSendResult({ response: "plain" }) });
    const isolated = stubRunner({ result: mkSendResult({ response: "isolated" }) });
    h.bindRunner(plain.send);
    h.bindIsolationRunner(isolated.send);

    const r = await (await h.run("s", { isolate: true, args: { x: 1 } })).result;

    // The isolation runner answered — the plain (same-session) runner was untouched.
    expect(r.response).toBe("isolated");
    expect(isolated.captured).toHaveLength(1);
    expect(plain.captured).toHaveLength(0);
    // Same composed send (skill body + serialized args) rides the isolated path.
    expect(isolated.captured[0]!.messages![0]!.content).toContain("body");
    await h.close();
  });

  it("no bound runner → SkillRunnerUnbound (typed, not an undefined-crash)", async () => {
    const h = await mkHarness();
    await h.register({ name: "s", description: "x", content: "body" });

    await expect(h.run("s")).rejects.toMatchObject({ _tag: "SkillRunnerUnbound", skillName: "s" });
    await h.close();
  });

  it("missing skill → SkillNotFound propagates (via require)", async () => {
    const h = await mkHarness();
    const { send } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await expect(h.run("nope")).rejects.toMatchObject({ _tag: "SkillNotFound", skillName: "nope" });
    await h.close();
  });
});

/**
 * Materialization provenance — a run's messages carry WHO composed them.
 *
 * A skill run is a `session.send` primed with the skill document, so without a
 * stamp a chat projection has to render the whole document as if the human typed
 * it. The stamp is `metadata.source.skill`: the name, the adopter's declared
 * `version`, and — since `skills:run` became a declared command (#249) — the
 * `opId` linking the entry back to its journal envelope. Every field is a fact
 * already in hand; nothing is derived or hashed.
 *
 * @see docs/proposals/v2/materialization-provenance.md §3
 */
describe("skills.run — materialization provenance", () => {
  /** The documented reader path: cast `metadata.source` to `MessageSource`, then key. */
  const skillSourceOf = (m: { readonly metadata?: Readonly<Record<string, unknown>> }) =>
    (m.metadata?.source as MessageSource | undefined)?.skill;

  it("stamps name + declared version on every composed message", async () => {
    const h = await mkHarness();
    await h.register({ name: "s", description: "x", content: "body", version: "3" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await h.run("s", { args: { x: 1 } });

    const messages = captured[0]!.messages!;
    expect(messages).toHaveLength(2); // default composition: system body + user args
    for (const m of messages) {
      expect(skillSourceOf(m)).toMatchObject({ name: "s", version: "3" });
      // Every message on ONE run carries THAT run's op — one operation, one id.
      expect(skillSourceOf(m)?.opId).toBe(skillSourceOf(messages[0]!)?.opId);
      expect(skillSourceOf(m)?.opId).toMatch(/^skills:run:/);
    }

    await h.close();
  });

  it("omits version when the skill declares none", async () => {
    const h = await mkHarness();
    await h.register({ name: "s", description: "x", content: "body" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await h.run("s");

    const source = skillSourceOf(captured[0]!.messages![0]!);
    expect(source?.version).toBeUndefined();
    expect(source).toMatchObject({ name: "s" });

    await h.close();
  });

  it("stamps a composeRun OVERRIDE's messages too, merging its metadata", async () => {
    // The framework is what put this in the timeline, so the stamp must not be
    // opt-out-able by replacing the composition.
    const composeRun: SkillRunCompose = (skill) => ({
      messages: [
        { role: "user", content: `custom: ${skill.name}`, metadata: { adopterKey: 7 } },
        { role: "user", content: "second" },
      ],
    });
    const h = await mkHarness({ composeRun });
    await h.register({ name: "s", description: "x", content: "body", version: "9" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await h.run("s");

    const [first, second] = captured[0]!.messages!;
    expect(first!.metadata?.adopterKey).toBe(7);
    expect(skillSourceOf(first!)).toMatchObject({ name: "s", version: "9" });
    expect(skillSourceOf(second!)).toMatchObject({ name: "s", version: "9" });

    await h.close();
  });

  it("does NOT overwrite a source the composition stamped itself", async () => {
    const composeRun: SkillRunCompose = () => ({
      messages: [{ role: "user", content: "quoted", metadata: { source: { telegram: 42 } } }],
    });
    const h = await mkHarness({ composeRun });
    await h.register({ name: "s", description: "x", content: "body" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await h.run("s");

    const message = captured[0]!.messages![0]!;
    expect(skillSourceOf(message)).toBeUndefined();
    expect(message.metadata?.source).toEqual({ telegram: 42 });

    await h.close();
  });
});

/**
 * `skills:run` is an OPERATION (#249) — the hole this closed.
 *
 * `run` used to be a plain method: it composed a whole skill document into the
 * timeline and left no journal envelope, no guard seam, and no opId for the
 * provenance stamp to carry. Prompt materialization (`prompts:invoke`) was a
 * journaled op the entire time; the exactly-analogous skill materialization was
 * invisible to the same machinery. The verb is now declared, so the run gets
 * what every other skills verb already had.
 *
 * The public signature is unchanged — `run(name, opts)` still returns the live
 * handle — which is also why the command is `exposure: "internal"`: the result
 * is an event stream plus an `abort()`, not data, so it cannot honestly cross
 * the inbox or the wire. The VERB-MATRIX parks `session:send` (which a run IS)
 * on that same blocker.
 *
 * @see https://github.com/agenticklabs/agentick/issues/249
 */
describe("skills:run — the op is the record", () => {
  /**
   * Subscribe to the skills surface and return the collecting array. Awaits one
   * macrotask so the Stream subscription is attached before the caller acts —
   * the same yield `harness.spec.ts` uses for its envelope assertions.
   */
  async function watch(bus: LocalEventBus): Promise<ProtocolEvent[]> {
    const observed: ProtocolEvent[] = [];
    Effect.runFork(
      Stream.runForEach(bus.subscribe({ surface: "skills" }), (e) =>
        Effect.sync(() => {
          observed.push(e);
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));
    return observed;
  }

  const runEnvelopes = (observed: readonly ProtocolEvent[]): readonly ProtocolEvent[] =>
    observed.filter((e) => e.name === "skills:command:run");

  it("mints requested → terminal envelopes for the run", async () => {
    const bus = new LocalEventBus();
    const h = new SkillsHarness(`op:${generateId()}`, new MemoryJournal(), bus, new LocalInbox());
    await h.ready;
    const observed = await watch(bus);

    await h.register({ name: "s", description: "d", content: "body" });
    h.bindRunner(stubRunner({ result: mkSendResult() }).send);
    await h.run("s");

    await waitFor(() => runEnvelopes(observed).some((e) => e.phase === "terminal"));
    const phases = runEnvelopes(observed).map((e) => e.phase);
    expect(phases[0]).toBe("requested");
    expect(phases.at(-1)).toBe("terminal");
    expect(runEnvelopes(observed).at(-1)?.outcome).toBe("succeeded");
    // ONE operation, so one id across both phases.
    expect(new Set(runEnvelopes(observed).map((e) => e.opId)).size).toBe(1);
    await h.close();
  });

  it("a FAILED run is journaled too — the record is not success-only", async () => {
    const bus = new LocalEventBus();
    const h = new SkillsHarness(`op:${generateId()}`, new MemoryJournal(), bus, new LocalInbox());
    await h.ready;
    const observed = await watch(bus);

    h.bindRunner(stubRunner({ result: mkSendResult() }).send);
    await expect(h.run("nope")).rejects.toMatchObject({ _tag: "SkillNotFound" });

    const terminal = await waitFor(() =>
      runEnvelopes(observed).find((e) => e.phase === "terminal"),
    );
    expect(terminal.outcome).toBe("failed");
    await h.close();
  });

  it("a guard VETOES the run — no send is composed, nothing reaches the timeline", async () => {
    const h = await mkHarness({
      guards: {
        run: (input) =>
          input.name === "dangerous" ? { kind: "veto", reason: "not allowed" } : undefined,
      },
    });
    await h.register({ name: "dangerous", description: "d", content: "body" });
    await h.register({ name: "safe", description: "d", content: "body" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await expect(h.run("dangerous")).rejects.toMatchObject({
      outcome: "vetoed",
      terminal: { outcome: "vetoed", reason: "not allowed" },
    });
    // What a guard is FOR: the skill document never became a send.
    expect(captured).toHaveLength(0);

    await h.run("safe");
    expect(captured).toHaveLength(1);
    await h.close();
  });

  it("the stamp's opId IS the run op's id — an entry navigates back to the journal", async () => {
    const bus = new LocalEventBus();
    const h = new SkillsHarness(`op:${generateId()}`, new MemoryJournal(), bus, new LocalInbox());
    await h.ready;
    const observed = await watch(bus);

    await h.register({ name: "s", description: "d", content: "body" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);
    await h.run("s");

    const requested = await waitFor(() => runEnvelopes(observed)[0]);
    const stamped = (captured[0]!.messages![0]!.metadata?.source as MessageSource | undefined)
      ?.skill;
    expect(stamped?.opId).toBe(requested.opId);
    await h.close();
  });
});
