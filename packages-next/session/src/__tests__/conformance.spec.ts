/**
 * Conformance suite invocation for `SessionHarness`.
 *
 * The session takes a real substrate + sub-harness stubs supplied by
 * the conformance suite. The factory wires `SessionHarness` against
 * them and waits for inbox + mount readiness before handing back.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import {
  defaultSessionConformanceDeps,
  runSessionConformance,
} from "@agentick/spec-conformance-next";

import { SessionHarness } from "../harness.js";

describe("SessionHarness — SessionHarnessProtocol conformance", () => {
  runSessionConformance(async ({ harnessId, deps }) => {
    // The suite's `defaultSessionConformanceDeps` returns an
    // intentionally minimal substrate (stubs that throw if invoked).
    // SessionHarness, by contrast, needs real journal/bus/inbox. We
    // construct them locally and rely on the suite-supplied
    // reconciler/loop/executor/toolExecutor stubs.
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const realDeps = defaultSessionConformanceDeps(
      { journal, bus, inbox },
      {
        reconciler: deps.reconciler,
        loop: deps.loop,
        modelExecutor: deps.modelExecutor,
        toolExecutor: deps.toolExecutor,
        target: deps.target,
        agent: deps.agent,
      },
    );

    const session = new SessionHarness(realDeps.journal, realDeps.bus, realDeps.inbox, {
      sessionId: harnessId,
      agent: realDeps.agent,
      reconciler: realDeps.reconciler,
      loop: realDeps.loop,
      modelExecutor: realDeps.modelExecutor,
      toolExecutor: realDeps.toolExecutor,
      target: realDeps.target,
    });
    await session.ready;
    await session.mountReady;
    return session;
  });
});
