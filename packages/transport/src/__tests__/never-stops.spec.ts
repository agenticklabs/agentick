/**
 * The dial loop does not stop — the base-class half.
 *
 * The transport e2e suites prove recovery over real wires. These cases drive
 * `BaseClientTransport` directly, because the ways a retry loop dies are mostly
 * NOT reachable from a real socket on demand: a subclass whose dial throws
 * synchronously, a dial that reports its failure to nobody, one dead wire
 * reported twice, a `discardWire()` that throws. Each of those used to be able
 * to end the loop silently — the transport sits in `connecting`, no state ever
 * changes again, and from the outside it is indistinguishable from a client
 * that is still trying.
 *
 * Also covers the subscription half of the same question: a resubscribe that
 * fails must not silently lose the subscription (transient) or hang its
 * consumer forever (permanent).
 */

import { describe, expect, it } from "vitest";
import type { EventFrame, JsonRpcFrame, TransportCapabilities } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import {
  BaseClientTransport,
  DEFAULT_KEEPALIVE_POLICY,
  DEFAULT_RECONNECT_POLICY,
  type ReconnectPolicy,
} from "../client/index.js";

const CAPABILITIES: TransportCapabilities = {
  bidirectional: true,
  streamingRequest: true,
  reconnectable: true,
  binaryFrames: false,
  media: false,
};

type DialBehavior = "succeed" | "reject-silently" | "throw-sync" | "hang";

/**
 * A transport whose wire is entirely under the test's control. `openConnection`
 * is deliberately NOT `async`, so `throw-sync` throws where a real subclass's
 * constructor call would — the case an `async` method cannot produce.
 */
class ProbeTransport extends BaseClientTransport {
  readonly id = "probe";
  readonly capabilities = CAPABILITIES;

  dials = 0;
  behavior: DialBehavior = "reject-silently";
  discardThrows = false;
  discards = 0;
  readonly sent: JsonRpcFrame[] = [];

  constructor(policy?: ReconnectPolicy) {
    super();
    this.reconnectPolicy = {
      ...DEFAULT_RECONNECT_POLICY,
      initialDelayMs: 2,
      maxDelayMs: 4,
      ...(policy ?? {}),
    };
    // The probe has no wire to go silently dead on; liveness is exercised
    // through `declareWireDead` directly.
    this.keepalivePolicy = { ...DEFAULT_KEEPALIVE_POLICY, enabled: false };
  }

  protected openConnection(): Promise<void> {
    this.dials++;
    this.explicitClose = false;
    this.setState("connecting");
    if (this.behavior === "throw-sync") throw new Error("dial threw synchronously");
    if (this.behavior === "reject-silently") {
      // The shape that used to wedge the loop: the dial fails and NOTHING
      // reports it — no close event, no drop, just a rejected promise.
      return Promise.reject(new Error("dial failed"));
    }
    if (this.behavior === "hang") {
      // The shape a loop armed by FAILURE cannot see: a dial that neither
      // succeeds nor fails. A proxy in front of a dead upstream, an ingress
      // that accepts and never upgrades.
      return new Promise<void>(() => {});
    }
    this.markWireUp();
    this.setState("open");
    this.resubscribeAfterReconnect();
    return Promise.resolve();
  }

  protected closeConnection(): Promise<void> {
    this.explicitClose = true;
    this.cancelReconnect();
    return Promise.resolve();
  }

  protected sendFrame(frame: JsonRpcFrame): void {
    this.sent.push(frame);
  }

  protected override discardWire(): void {
    this.discards++;
    if (this.discardThrows) throw new Error("discardWire threw");
  }

  // ── test seams over the protected surface ──────────────────────────────
  drop(): void {
    this.handleConnectionDrop();
  }
  killWire(reason = "probe"): void {
    this.declareWireDead(reason);
  }
  deliver(frame: JsonRpcFrame): void {
    this.routeFrame(frame);
  }
  /** The most recent `sub/subscribe` frame written to the wire. */
  private lastSubscribeFrame(): JsonRpcFrame & { id: unknown; params: unknown } {
    const frames = this.sent.filter((f) => "method" in f && f.method === "sub/subscribe");
    const last = frames[frames.length - 1];
    if (!last || !("id" in last)) throw new Error("no sub/subscribe frame written");
    return last as JsonRpcFrame & { id: unknown; params: unknown };
  }
  /** Its JSON-RPC id — what a response has to correlate by. */
  lastSubscribeId(): number {
    return this.lastSubscribeFrame().id as number;
  }
  /**
   * The subscription id the CLIENT allocated on it. A conforming server echoes
   * exactly this; anything else fails the subscription as a protocol breach.
   */
  lastSubscriptionId(): string {
    return (this.lastSubscribeFrame().params as { subscriptionId: string }).subscriptionId;
  }
  subscribeCount(): number {
    return this.sent.filter((f) => "method" in f && f.method === "sub/subscribe").length;
  }
  /** True once the base has dropped its registration — the subscription is over. */
  streamEnded(): boolean {
    return this.activeSubscriptions.size === 0;
  }
}

describe("the dial loop cannot be stopped by a failing dial", () => {
  it("keeps dialing when a dial reports its failure to NOBODY", async () => {
    // No close event, no drop — just a rejected promise the loop used to
    // swallow, leaving the transport parked in `connecting` forever (#262).
    const t = new ProbeTransport();
    await expect(t.connect()).rejects.toThrow(/dial failed/);
    await waitFor(() => t.dials >= 4, { description: "loop kept dialing" });
    await t.close();
  });

  it("survives a dial that throws SYNCHRONOUSLY inside the retry timer", async () => {
    // Uncaught inside a `setTimeout` callback this would take the loop with it
    // — and, under Node's default unhandled-rejection policy, the process.
    const t = new ProbeTransport();
    t.behavior = "throw-sync";
    await expect(t.connect()).rejects.toThrow(/synchronously/);
    await waitFor(() => t.dials >= 4, { description: "loop survived the sync throw" });
    await t.close();
  });

  it("recovers on its own once the dial starts working", async () => {
    const t = new ProbeTransport();
    await t.connect().catch(() => {});
    await waitFor(() => t.dials >= 2, { description: "loop running" });
    t.behavior = "succeed";
    await waitFor(() => t.state === "open", { description: "came up on its own" });
    await t.close();
  });

  it("reporting one dead wire twice arms ONE loop, not two", async () => {
    const t = new ProbeTransport();
    t.behavior = "succeed";
    await t.connect();
    const before = t.dials;

    // `declareWireDead` reports a wire whose close event then reports it again
    // — the shape that used to orphan a timer and leave two loops racing.
    t.drop();
    t.drop();
    t.drop();

    await waitFor(() => t.state === "open", { description: "the one loop redialed" });
    // Three reports, ONE dial. Un-deduplicated, each report would have armed
    // its own timer and every one of them would have fired.
    await new Promise((r) => setTimeout(r, 40));
    expect(t.dials).toBe(before + 1);
    await t.close();
  });

  it("declares the wire dead even when discardWire() throws", async () => {
    const t = new ProbeTransport();
    t.behavior = "succeed";
    await t.connect();
    t.discardThrows = true;
    t.behavior = "reject-silently";

    t.killWire("liveness probe unanswered");

    // The throw must not skip the drop path and leave the transport parked in
    // `open` on a wire nobody is listening to.
    expect(t.discards).toBe(1);
    expect(t.state).not.toBe("open");
    await waitFor(() => t.dials >= 2, { description: "loop took over" });
    await t.close();
  });

  it("stops only when a FINITE budget runs out, and says so", async () => {
    const t = new ProbeTransport({ maxAttempts: 2 });
    await t.connect().catch(() => {});
    await waitFor(() => typeof t.state === "object", { description: "budget spent" });
    const state = t.state;
    if (typeof state === "string") throw new Error("expected the failed state");
    expect(state.kind).toBe("failed");
    expect("message" in state.error && state.error.message).toMatch(/maxAttempts = 2/);

    // Terminal means terminal: nothing dials afterwards.
    const settled = t.dials;
    await new Promise((r) => setTimeout(r, 40));
    expect(t.dials).toBe(settled);
    await t.close();
  });

  it("abandons a dial that never answers, and keeps dialing", async () => {
    // Nothing else can report this one. The dial holds forever, so no close
    // event fires, no rejection arrives, and a loop armed only by failure is
    // armed by nothing at all — the transport parks in `connecting` for the
    // life of the process.
    const t = new ProbeTransport({ dialTimeoutMs: 20 });
    t.behavior = "hang";
    await expect(t.connect()).rejects.toThrow(/unanswered/);

    await waitFor(() => t.dials >= 3, { description: "loop kept dialing past the deadline" });
    // Each abandoned dial releases its half-open wire; otherwise the redial
    // competes with a socket that will never answer.
    expect(t.discards).toBeGreaterThanOrEqual(2);
    await t.close();
  });

  it("a second connect() joins the dial in flight instead of opening another", async () => {
    // Two racing dials leave a loser whose listeners the subclass's staleness
    // guard mutes: its caller's promise never settles (an adopter awaits a
    // connection that may already be open) and its wire is never released.
    const t = new ProbeTransport({ dialTimeoutMs: 60 });
    t.behavior = "hang";

    const first = t.connect().then(
      () => "resolved",
      () => "rejected",
    );
    const second = t.connect().then(
      () => "resolved",
      () => "rejected",
    );
    expect(t.dials).toBe(1);

    const settled = await Promise.race([
      Promise.all([first, second]),
      new Promise((r) => setTimeout(() => r("hung"), 500)),
    ]);
    expect(settled).toEqual(["rejected", "rejected"]);
    await t.close();
  });

  it("ends an in-flight PROGRESS stream on the drop — it can never be re-opened", async () => {
    // The send's own RPC rejects with everything else in `pending`, but a
    // caller rendering a live turn is not awaiting that promise — it is
    // awaiting this iterator. A progress token names one operation on a
    // connection that is gone and no verb re-attaches to it, so silence here
    // is silence for the life of the process: a UI stuck rendering a turn that
    // will never end.
    const t = new ProbeTransport();
    t.behavior = "succeed";
    await t.connect();
    const progress = t.progress("tok-1");

    const drained = Promise.race([
      (async () => {
        try {
          for await (const _ of progress) void _;
          return "ended-clean" as const;
        } catch (e) {
          return e;
        }
      })(),
      new Promise((r) => setTimeout(() => r("hung"), 500)),
    ]);

    t.drop();

    const outcome = await drained;
    expect(outcome).not.toBe("hung");
    // The failure, not a clean end: the operation may still be RUNNING on the
    // server, and "the stream died" is a different fact from "it finished".
    expect(outcome).not.toBe("ended-clean");
    expect((outcome as { kind?: string }).kind).toBe("closed");
    await t.close();
  });

  it("a deliberate close() during backoff ends it", async () => {
    const t = new ProbeTransport();
    await t.connect().catch(() => {});
    await waitFor(() => t.dials >= 2, { description: "loop running" });
    await t.close();

    const settled = t.dials;
    await new Promise((r) => setTimeout(r, 40));
    expect(t.dials).toBe(settled);
    expect(t.state).toBe("closed");
  });
});

describe("a subscription that does not survive a reconnect", () => {
  /** Open the wire and establish one server-acknowledged subscription. */
  async function withSubscription(policy?: ReconnectPolicy): Promise<{
    t: ProbeTransport;
    sub: ReturnType<ProbeTransport["subscribe"]>;
  }> {
    const t = new ProbeTransport(policy);
    t.behavior = "succeed";
    await t.connect();
    const sub = t.subscribe({ kind: "session", id: "s1" });
    t.deliver({
      jsonrpc: "2.0",
      id: t.lastSubscribeId(),
      result: { subscriptionId: t.lastSubscriptionId() },
    });
    return { t, sub };
  }

  it("survives a drop that lands mid-resubscribe, and is retried on the NEXT reconnect", async () => {
    // The silent-loss bug: the pre-#263 code removed the subscription from
    // `activeSubscriptions` BEFORE the resubscribe was acknowledged, so a wire
    // that dropped in that window took the subscription with it — permanently,
    // and with no error anywhere.
    const { t } = await withSubscription();
    expect(t.subscribeCount()).toBe(1);

    // Wire drops; the redial succeeds and resubscribes...
    t.drop();
    await waitFor(() => t.subscribeCount() === 2, { description: "resubscribe issued" });
    // ...but the wire goes again before the server answers it.
    t.drop();

    // The subscription is not lost: the next reconnect asks again.
    await waitFor(() => t.subscribeCount() === 3, {
      description: "resubscribed after the second reconnect",
    });
    await t.close();
  });

  it("ends the stream when the SERVER refuses it — no redial will change that answer", async () => {
    const { t, sub } = await withSubscription();
    t.drop();
    await waitFor(() => t.subscribeCount() === 2, { description: "resubscribe issued" });

    // The server says no. A consumer blocked on `for await` would otherwise
    // wait for the life of the process.
    t.deliver({
      jsonrpc: "2.0",
      id: t.lastSubscribeId(),
      error: { code: -32003, message: 'not authorized for "sub:subscribe"' },
    });

    const outcome = await drain(sub);
    expect(outcome).not.toBe("hung");
    expect((outcome as { kind?: string }).kind).toBe("rpc");
    await t.close();
  });

  it("re-asks while the peer says the SCOPE is not there — that answer expires", async () => {
    // A gateway that restarted answers `SessionNotFound` for every session the
    // adopter has not rebuilt yet, and the wire is back long before it has.
    // Final at the instant it is given, wrong a moment later.
    const { t, sub } = await withSubscription();
    t.drop();
    await waitFor(() => t.subscribeCount() === 2, { description: "resubscribe issued" });

    t.deliver({
      jsonrpc: "2.0",
      id: t.lastSubscribeId(),
      error: { code: -32010, message: "session s1 not found" },
    });

    // Asked again rather than killed.
    await waitFor(() => t.subscribeCount() === 3, { description: "re-asked after not-found" });
    const outcome = await Promise.race([
      drain(sub),
      new Promise((r) => setTimeout(() => r("still-open"), 100)),
    ]);
    expect(outcome).toBe("still-open");
    await t.close();
  });

  it("gives up on a scope that stays missing past the grace window", async () => {
    // The window is what separates a session being rebuilt from one that is
    // gone: both say the same thing, so only time tells them apart.
    const { t, sub } = await withSubscription({ resubscribeGraceMs: 30 });
    t.drop();
    await waitFor(() => t.subscribeCount() === 2, { description: "resubscribe issued" });

    for (let i = 0; i < 20 && !t.streamEnded(); i++) {
      t.deliver({
        jsonrpc: "2.0",
        id: t.lastSubscribeId(),
        error: { code: -32010, message: "session s1 not found" },
      });
      await new Promise((r) => setTimeout(r, 10));
    }

    const outcome = await drain(sub);
    expect(outcome).not.toBe("hung");
    expect((outcome as { kind?: string }).kind).toBe("rpc");
    await t.close();
  });

  it("ends a fresh subscribe the server never acknowledges", async () => {
    const t = new ProbeTransport();
    t.behavior = "succeed";
    await t.connect();
    const sub = t.subscribe({ kind: "session", id: "s1" });
    t.deliver({
      jsonrpc: "2.0",
      id: t.lastSubscribeId(),
      error: { code: -32601, message: "sub/subscribe" },
    });

    const outcome = await drain(sub);
    expect(outcome).not.toBe("hung");
    expect((outcome as { kind?: string }).kind).toBe("rpc");
    await t.close();
  });
});

/** Iterate a subscription stream, returning what ended it (or `"hung"`). */
async function drain(sub: AsyncIterable<EventFrame>): Promise<unknown> {
  return Promise.race([
    (async () => {
      try {
        for await (const _ of sub) {
          /* drain */
        }
        return "ended" as const;
      } catch (e) {
        return e;
      }
    })(),
    new Promise((r) => setTimeout(() => r("hung"), 500)),
  ]);
}
