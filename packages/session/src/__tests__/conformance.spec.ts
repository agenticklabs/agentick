/**
 * Conformance suite invocation for `SessionHarness`.
 *
 * The session takes a real substrate + sub-harness stubs supplied by
 * the conformance suite. The factory wires `SessionHarness` against
 * them and waits for inbox + mount readiness before handing back.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { defaultSessionConformanceDeps, runSessionConformance } from "@agentick/spec-conformance";

import { SessionHarness } from "../harness.js";

describe("SessionHarness — SessionHarnessProtocol conformance", () => {
  runSessionConformance(async ({ harnessId, deps }) => {
    // The suite's `defaultSessionConformanceDeps` returns an
    // intentionally minimal substrate (stubs that throw if invoked).
    // SessionHarness, by contrast, needs real journal/bus/inbox. We
    // construct them locally and rely on the suite-supplied
    // compiler/loop/executor/toolExecutor stubs.
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const realDeps = defaultSessionConformanceDeps(
      { journal, bus, inbox },
      {
        compiler: deps.compiler,
        loop: deps.loop,
        modelExecutor: deps.modelExecutor,
        toolExecutor: deps.toolExecutor,
        target: deps.target,
        agent: deps.agent,
        ...(deps.checkpointBridge !== undefined ? { checkpointBridge: deps.checkpointBridge } : {}),
      },
    );

    const session = new SessionHarness(realDeps.journal, realDeps.bus, realDeps.inbox, {
      sessionId: harnessId,
      agent: realDeps.agent,
      compiler: realDeps.compiler,
      loop: realDeps.loop,
      modelExecutor: realDeps.modelExecutor,
      toolExecutor: realDeps.toolExecutor,
      target: realDeps.target,
      // The suite's checkpoint section observes the fan-out through a bridge it
      // supplies, so the factory's job is to put it on the bag.
      ...(realDeps.checkpointBridge !== undefined
        ? { extensionBridges: new Map([["conformanceCheckpoint", realDeps.checkpointBridge]]) }
        : {}),
    });
    await session.ready;
    await session.mountReady;
    return session;
  });
});
