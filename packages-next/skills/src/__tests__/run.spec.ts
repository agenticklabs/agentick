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
 *   - `isolate: true` → `SkillIsolationUnavailable` (C2 deferral, never inline)
 *   - missing skill → `SkillNotFound` propagates (via `require`)
 *   - no bound runner → `SkillRunnerUnbound` (not an undefined-crash)
 *
 * The real end-to-end path (a scripted terminal-tool call → validated `data`,
 * the steer-conflict reentrancy) lives in `@agentick/app-next`, where the
 * session + injection site are dependencies.
 *
 * @see docs/proposals/v2/three-audiences-plan.md §C
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type {
  SendInput,
  SendResult,
  SessionExecutionHandle,
  SessionSendCapability,
} from "@agentick/spec-next";

import { SkillsHarness } from "../harness.js";
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
      abort: async () => {},
    };
    // Prevent unhandled-rejection noise on the reject path (the test awaits it
    // through `run`).
    if (opts.reject !== undefined) void handle.result.catch(() => {});
    return handle;
  };
  return { send, captured };
}

async function mkHarness(): Promise<SkillsHarness> {
  const h = new SkillsHarness(
    `run:${ulid()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
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
      `run:${ulid()}`,
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
  it("isolate: true → SkillIsolationUnavailable (never silently inline)", async () => {
    const h = await mkHarness();
    await h.register({ name: "s", description: "x", content: "body" });
    const { send, captured } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await expect(h.run("s", { isolate: true })).rejects.toMatchObject({
      _tag: "SkillIsolationUnavailable",
      name: "s",
    });
    // The runner was never invoked — no inline fallback.
    expect(captured).toHaveLength(0);
    await h.close();
  });

  it("no bound runner → SkillRunnerUnbound (typed, not an undefined-crash)", async () => {
    const h = await mkHarness();
    await h.register({ name: "s", description: "x", content: "body" });

    await expect(h.run("s")).rejects.toMatchObject({ _tag: "SkillRunnerUnbound", name: "s" });
    await h.close();
  });

  it("missing skill → SkillNotFound propagates (via require)", async () => {
    const h = await mkHarness();
    const { send } = stubRunner({ result: mkSendResult() });
    h.bindRunner(send);

    await expect(h.run("nope")).rejects.toMatchObject({ _tag: "SkillNotFound", name: "nope" });
    await h.close();
  });
});
