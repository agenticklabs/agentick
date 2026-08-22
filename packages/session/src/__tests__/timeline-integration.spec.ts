/**
 * The session integrates the TIMELINE — what a send and the state applicators
 * actually put on the durable log.
 *
 * These lived in `runSessionConformance` until the ADR-27 pass: reading
 * `session.timeline` names a namespace, and generic infra names none. They are
 * "session + timeline" integration tests, so they live in the package that
 * dev-depends on both.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { defaultSessionConformanceDeps } from "@agentick/spec-conformance";
import { SPEC_VERSION, type ContentBlock, type TimelineEntry } from "@agentick/spec";

import { SessionHarness } from "../harness.js";

/**
 * The same wiring `conformance.spec.ts` uses — real substrate, the conformance
 * suite's sub-harness stubs — so these tests exercise the session an adopter
 * gets, not a bespoke rig.
 */
async function mkSession(sessionId: string): Promise<SessionHarness> {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const deps = defaultSessionConformanceDeps({ journal, bus, inbox });
  const session = new SessionHarness(deps.journal, deps.bus, deps.inbox, {
    sessionId,
    agent: deps.agent,
    compiler: deps.compiler,
    loop: deps.loop,
    modelExecutor: deps.modelExecutor,
    toolExecutor: deps.toolExecutor,
    target: deps.target,
  });
  await session.ready;
  await session.mountReady;
  return session;
}

const persisted = (session: SessionHarness): readonly TimelineEntry[] =>
  session.timeline.readPersisted();

describe("SessionHarness + timeline — send", () => {
  it("appends caller-supplied messages before the execution runs", async () => {
    const session = await mkSession("tl-int-1");
    await session.send({
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    });
    const userMessages = persisted(session).filter(
      (e) => e.kind === "message" && e.message.role === "user",
    );
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    await session.close();
  });

  it("appends an assistant message after the loop's applyExecutorResult", async () => {
    const session = await mkSession("tl-int-2");
    await (
      await session.send({ messages: [{ role: "user", content: "x" }] })
    ).result;
    const assistant = persisted(session).find(
      (e) => e.kind === "message" && e.message.role === "assistant",
    );
    expect(assistant).toBeDefined();
    await session.close();
  });
});

describe("SessionHarness + timeline — state applicators", () => {
  it("appendEntry lands the entry on the durable log", async () => {
    const session = await mkSession("tl-int-apply-1");
    const content: ContentBlock[] = [{ type: "text", text: "marker" }];
    const res = await session.appendEntry({
      sessionId: "tl-int-apply-1",
      entry: { role: "user", content },
    });
    expect(res.appendedEntryIds.length).toBe(1);
    const marker = persisted(session).find(
      (e) =>
        e.kind === "message" &&
        e.message.content.some((b) => b.type === "text" && b.text === "marker"),
    );
    expect(marker).toBeDefined();
    await session.close();
  });

  it("applyExecutorResult appends an assistant message carrying the output", async () => {
    const session = await mkSession("tl-int-apply-2");
    await session.applyExecutorResult({
      sessionId: "tl-int-apply-2",
      executionId: "exec-x",
      tickId: "tick-x",
      result: {
        specVersion: SPEC_VERSION,
        output: [{ type: "text", text: "from-applicator" }],
        stopReason: "end",
      },
    });
    const found = persisted(session).find(
      (e) =>
        e.kind === "message" &&
        e.message.role === "assistant" &&
        e.message.content.some((b) => b.type === "text" && b.text === "from-applicator"),
    );
    expect(found).toBeDefined();
    await session.close();
  });

  it("applyToolResults appends one tool message per result", async () => {
    const session = await mkSession("tl-int-apply-3");
    await session.applyToolResults({
      sessionId: "tl-int-apply-3",
      executionId: "exec-y",
      tickId: "tick-y",
      results: [
        {
          toolCallId: "tc-1",
          toolName: "calc",
          succeeded: true,
          content: [{ type: "text", text: "42" }],
          durationMs: 1,
        },
        {
          toolCallId: "tc-2",
          toolName: "calc",
          succeeded: true,
          content: [{ type: "text", text: "84" }],
          durationMs: 1,
        },
      ],
    });
    const toolMessages = persisted(session).filter(
      (e) => e.kind === "message" && e.message.role === "tool",
    );
    expect(toolMessages.length).toBeGreaterThanOrEqual(2);
    await session.close();
  });
});
