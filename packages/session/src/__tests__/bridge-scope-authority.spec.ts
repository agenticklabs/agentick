/**
 * Every session-owned harness knows which session it is inside.
 *
 * The companion to `spec-conformance/event-scope-authority.spec.ts`, and it catches
 * the opposite failure. That one is a text gate: it fires when a harness stamps its
 * own composed `scopeId` as `EventScope.sessionId`. This one fires when a harness
 * stamps NOTHING and was never told — the omission case, which no grep can see.
 *
 * Both were live at once. `session-bridges` builds seven harnesses; two were handed
 * an ad-hoc `parentScope` and five were not, so five emitted events carrying either
 * the wrong session or none, and the gateway — which narrows a
 * `{ kind: "session", id }` subscription to `scope.sessionId === id` — matched
 * nothing for any of them. Silently: the subscriptions opened and stayed open.
 *
 * The check is structural rather than behavioural on purpose. Driving every surface
 * to actually emit would mean seven bespoke setups, each able to rot independently
 * and each easy to omit for a NEW surface. Reading `harness.parentScope` off the
 * assembled bundle needs no per-surface knowledge at all, so a harness added next
 * year is covered by this test the moment it appears in `HookBridges` — which is the
 * only property that makes an anti-rot test worth having.
 *
 * @see packages/transport-in-process/src/__tests__/timeline-live-tail-e2e.spec.ts
 *   — the behavioural proof, end to end over a real gateway and client.
 */

import { describe, expect, it } from "vitest";
import { BaseHarness } from "@agentick/runtime";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";

import { buildSessionBridges } from "../session-bridges.js";
import { SessionRuntime } from "../session-state.js";

const SESSION_ID = "scope-authority-session";

/** Every bundle value that is a harness — the things whose events need a scope. */
function harnessesIn(bundle: object): ReadonlyArray<readonly [string, BaseHarness]> {
  const out: Array<readonly [string, BaseHarness]> = [];
  for (const [name, value] of Object.entries(bundle)) {
    if (value instanceof BaseHarness) out.push([name, value as BaseHarness]);
  }
  return out;
}

function bridges() {
  const journal = new MemoryJournal({ capacity: 4096 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const runtime = new SessionRuntime({
    id: SESSION_ID,
    store: undefined,
    storeCtx: () => ({}),
  });
  return buildSessionBridges(runtime, { journal, bus, inbox });
}

describe("session-owned harnesses declare their owning session", () => {
  it("every harness in the bundle carries parentScope.sessionId", () => {
    // Named, not counted: a failure has to say which harness to wire. The fix is
    // always the same — route its construction through `sessionScoped()` in
    // `session-bridges.ts`.
    const bundle = bridges();
    const missing = harnessesIn(bundle)
      .filter(([, h]) => h.parentScope?.sessionId !== SESSION_ID)
      .map(([name, h]) => `${name} (parentScope.sessionId=${String(h.parentScope?.sessionId)})`);
    expect(missing).toEqual([]);
  });

  it("and it is the SESSION id, not the harness's own composed scope key", () => {
    // The distinction the whole seam exists for. Asserted as an inequality because
    // the two values are one string-concatenation apart, and a fix that set
    // `parentScope: { sessionId: scopeId }` would satisfy the test above while
    // reintroducing the exact bug.
    for (const [, harness] of harnessesIn(bridges())) {
      expect(harness.parentScope?.sessionId).toBe(SESSION_ID);
      // `address` is `<surface>:<scopeId>` — the public face of the WORK identity.
      // It contains the session id and is never equal to it, which is the whole
      // distinction: a fix that set `parentScope: { sessionId: scopeId }` would pass
      // the check above while reintroducing the exact bug.
      expect(harness.address).toContain(SESSION_ID);
      expect(harness.address).not.toBe(harness.parentScope?.sessionId);
    }
  });

  it("the sweep is non-vacuous — the bundle really does hold harnesses", () => {
    // A refactor that stopped exposing harnesses on the bundle, or an `instanceof`
    // that silently stopped narrowing across a package boundary, would make both
    // checks above pass by inspecting an empty list.
    const names = harnessesIn(bridges()).map(([name]) => name);
    expect(names.length).toBeGreaterThanOrEqual(5);
    // The surfaces that were actually broken, spelled out so a rename cannot quietly
    // drop one from coverage.
    expect(names).toEqual(expect.arrayContaining(["timeline", "knobs", "state"]));
  });
});
