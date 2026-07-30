/**
 * #246 — `session.close()` used to fire the `session/close` RPC and nothing else.
 * Every sub-handle built along the way (`session.knobs`, `session.timeline`, …)
 * kept its wire subscription open and its listeners live, for the lifetime of the
 * page. Closing the session now closes what it built, first, then sends the RPC.
 *
 * The two properties that make it safe: an untouched getter is never materialized
 * by teardown (closing must not OPEN a subscription), and a sub-handle whose
 * `close()` throws neither stops its siblings nor suppresses the RPC.
 */

import { describe, expect, it, vi } from "vitest";

import { makeSessionHandle } from "../handles.js";
import { registerSessionHandleExtension } from "../session-handle-extensions.js";

type InternalClientArg = Parameters<typeof makeSessionHandle>[0];

function fakeClient() {
  const request = vi.fn(async () => null);
  const client = { id: "c1", request, transport: {} } as unknown as InternalClientArg;
  return { client, request };
}

/** A channel-fold stand-in: `close()` releases the subscription, idempotently. */
function foldHandle() {
  const state = { built: 0, closes: 0, subscribed: true };
  return {
    state,
    factory: () => {
      state.built++;
      return {
        subscribe: () => () => undefined,
        close: () => {
          state.closes++;
          state.subscribed = false;
        },
      };
    },
  };
}

function slot(session: object, name: string): unknown {
  return (session as unknown as Record<string, unknown>)[name];
}

describe("session.close() tears down every BUILT sub-handle", () => {
  it("releases the subscriptions of the handles that were built", async () => {
    const knobs = foldHandle();
    const tasks = foldHandle();
    registerSessionHandleExtension("knobslike", knobs.factory);
    registerSessionHandleExtension("taskslike", tasks.factory);

    const { client, request } = fakeClient();
    const session = makeSessionHandle(client, "s1");

    // Build two — the getters are lazy, so touching them is what opens the wire.
    void slot(session, "knobslike");
    void slot(session, "taskslike");
    expect(knobs.state.subscribed).toBe(true);
    expect(tasks.state.subscribed).toBe(true);

    await session.close();

    expect(knobs.state.subscribed).toBe(false);
    expect(tasks.state.subscribed).toBe(false);
    expect(knobs.state.closes).toBe(1);
    expect(tasks.state.closes).toBe(1);
    expect(request).toHaveBeenCalledWith("session/close", { sessionId: "s1" });
  });

  it("does NOT materialize a getter that was never touched", async () => {
    const untouched = foldHandle();
    registerSessionHandleExtension("untouched", untouched.factory);

    const session = makeSessionHandle(fakeClient().client, "s1");
    await session.close();

    expect(untouched.state.built).toBe(0);
    expect(untouched.state.closes).toBe(0);
  });

  it("is idempotent — a second close re-sends the RPC but closes nothing twice", async () => {
    const fold = foldHandle();
    registerSessionHandleExtension("idem", fold.factory);

    const { client, request } = fakeClient();
    const session = makeSessionHandle(client, "s1");
    void slot(session, "idem");

    await session.close();
    await session.close();

    expect(fold.state.closes).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("a throwing close does not stop siblings, nor the RPC; failures aggregate", async () => {
    const survivor = foldHandle();
    registerSessionHandleExtension("thrower", () => ({
      close: () => {
        throw new Error("boom");
      },
    }));
    registerSessionHandleExtension("survivor", survivor.factory);

    const { client, request } = fakeClient();
    const session = makeSessionHandle(client, "s1");
    void slot(session, "thrower");
    void slot(session, "survivor");

    await expect(session.close()).rejects.toBeInstanceOf(AggregateError);
    expect(survivor.state.closes).toBe(1);
    expect(request).toHaveBeenCalledWith("session/close", { sessionId: "s1" });
  });

  it("skips a sub-handle that has no close() at all", async () => {
    registerSessionHandleExtension("closeless", () => ({ marker: "no-close" }));
    const { client } = fakeClient();
    const session = makeSessionHandle(client, "s1");
    void slot(session, "closeless");
    await expect(session.close()).resolves.toBeUndefined();
  });
});
