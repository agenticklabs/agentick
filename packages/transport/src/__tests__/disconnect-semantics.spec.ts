import { describe, expect, it } from "vitest";
import type { JsonRpcFrame } from "@agentick/spec";
import type { DispatchHost } from "../server/dispatch.js";
import { BaseConnectionContext } from "../server/connection-context.js";

/**
 * Disconnect is not cancel. A connection close tears down what the
 * connection OWNS — subscriptions, its wire — and must NOT abort in-flight
 * RPCs: aborts are explicit (`notifications/cancelled`). A browser refresh
 * mid-turn leaves the execution running; the reconnecting client finds the
 * result in the session.
 */

class FakeConnection extends BaseConnectionContext {
  frames: JsonRpcFrame[] = [];
  wireClosed = false;
  protected sendFrame(frame: JsonRpcFrame): void {
    this.frames.push(frame);
  }
  protected closeWire(): void {
    this.wireClosed = true;
  }
}

const fakeGateway = {} as DispatchHost;

describe("connection close vs explicit cancel", () => {
  it("close() runs subscription cleanups but does NOT invoke in-flight aborts", async () => {
    const conn = new FakeConnection(fakeGateway);
    let aborted = 0;
    let unsubscribed = 0;
    conn.registerInFlight("rpc-1", () => {
      aborted++;
    });
    conn.registerSubscription("sub-1", async () => {
      unsubscribed++;
    });

    await conn.close();

    expect(unsubscribed).toBe(1);
    expect(aborted).toBe(0);
  });

  it("cancelInFlight (explicit) still aborts", () => {
    const conn = new FakeConnection(fakeGateway);
    let aborted = 0;
    conn.registerInFlight("rpc-1", () => {
      aborted++;
    });

    conn.cancelInFlight("rpc-1");

    expect(aborted).toBe(1);
  });
});
