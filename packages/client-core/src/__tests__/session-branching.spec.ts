/**
 * ADR 100 — the CLIENT half of session branching: the three conversation verbs
 * and their lowering, the `from` bag riding the one create door, the list
 * dimensions, and `relation()` reachable from this package.
 *
 * The verbs are sugar over `app/create_session`, never operations of their own
 * — so what there is to pin is the exact wire params each one produces, and the
 * two facts the client must NOT assert: no `appId` (the gateway resolves the
 * app from the source record) and no `seq` (genesis resolves it), plus an
 * absent `entryId` meaning the source's tip rather than a literal `undefined`.
 */

import { describe, expect, it, vi } from "vitest";
import type { SessionFilter, SessionFromInput } from "@agentick/spec";

import { makeAppHandle, makeSessionHandle } from "../handles.js";
import { relation } from "../index.js";

type InternalClientArg = Parameters<typeof makeAppHandle>[0];

function fakeClient() {
  const request = vi.fn(async (_method: string, _params: unknown) => ({
    sessionId: "s-new",
    status: "idle",
  }));
  const client = { id: "c1", request, transport: {} } as unknown as InternalClientArg;
  return { client, request };
}

/** The `from` bag of the single create the verb fired. */
function firedFrom(request: ReturnType<typeof fakeClient>["request"]) {
  const [method, params] = request.mock.calls[0]!;
  expect(method).toBe("app/create_session");
  return (params as { from: Record<string, unknown> }).from;
}

describe("the conversation verbs — wire lowering", () => {
  it("fork() with no anchor omits entryId AND appId — both server-resolved", () => {
    const { client, request } = fakeClient();

    const forked = makeSessionHandle(client, "s-src").fork();

    expect(request).toHaveBeenCalledTimes(1);
    const [, params] = request.mock.calls[0]!;
    expect(params).toEqual({
      sessionId: forked.id,
      from: { sessionId: "s-src", inherited: true, anchored: false },
    });
    // The two absences are the point: a client knows neither the tip nor the app.
    expect(params).not.toHaveProperty("appId");
    expect(firedFrom(request)).not.toHaveProperty("entryId");
    expect(firedFrom(request)).not.toHaveProperty("seq");
  });

  it("fork(entryId) anchors the branch at that entry, still unanchored as a session", () => {
    const { client, request } = fakeClient();

    makeSessionHandle(client, "s-src").fork("e-7");

    expect(firedFrom(request)).toEqual({
      sessionId: "s-src",
      entryId: "e-7",
      inherited: true,
      anchored: false,
    });
  });

  it("reply(entryId) is anchored — the side-thread that stays where it came from", () => {
    const { client, request } = fakeClient();

    makeSessionHandle(client, "s-src").reply("e-7");

    expect(firedFrom(request)).toEqual({
      sessionId: "s-src",
      entryId: "e-7",
      inherited: true,
      anchored: true,
    });
  });

  it("branch(input) passes its dispositions through verbatim", () => {
    const { client, request } = fakeClient();

    const child = makeSessionHandle(client, "s-src").branch({
      entryId: "e-3",
      anchored: true,
      inherited: false,
      sessionId: "s-chosen",
      metadata: { title: "spike" },
    });

    expect(child.id).toBe("s-chosen");
    expect(request).toHaveBeenCalledWith("app/create_session", {
      sessionId: "s-chosen",
      metadata: { title: "spike" },
      from: { sessionId: "s-src", entryId: "e-3", inherited: false, anchored: true },
    });
  });

  it("branch({}) defaults to inherited, unanchored — the same defaults the harness applies", () => {
    const { client, request } = fakeClient();

    makeSessionHandle(client, "s-src").branch({});

    expect(firedFrom(request)).toEqual({
      sessionId: "s-src",
      inherited: true,
      anchored: false,
    });
  });
});

describe("the conversation verbs — the handle they hand back", () => {
  it("returns the new session's handle SYNCHRONOUSLY, and it is the memoized one", () => {
    const { client } = fakeClient();

    const forked = makeSessionHandle(client, "s-src").fork();

    expect(typeof forked.id).toBe("string");
    expect(forked.id).not.toBe("s-src");
    expect(makeSessionHandle(client, forked.id)).toBe(forked);
  });

  it("mints a fresh id per call", () => {
    const { client } = fakeClient();
    const source = makeSessionHandle(client, "s-src");

    expect(source.fork().id).not.toBe(source.fork().id);
  });

  it("a failed create does not escape as an unhandled rejection", async () => {
    const { client, request } = fakeClient();
    request.mockRejectedValueOnce(new Error("nope"));

    const forked = makeSessionHandle(client, "s-src").fork();

    // The handle still comes back — the failure resurfaces on the next verb
    // sent to it, not as a process-killing rejection from a synchronous call.
    expect(forked.id).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("app.createSession — the ADR 100 `from` bag", () => {
  it("lowers the bag verbatim onto `app/create_session`", async () => {
    const { client, request } = fakeClient();
    const from: SessionFromInput = {
      sessionId: "s-source",
      entryId: "e-7",
      inherited: true,
      anchored: true,
    };

    await makeAppHandle(client, "app-1").createSession({ sessionId: "s-new", from });

    expect(request).toHaveBeenCalledWith("app/create_session", {
      appId: "app-1",
      sessionId: "s-new",
      metadata: undefined,
      eager: undefined,
      from,
    });
  });

  it("carries no `seq` — genesis resolves the entry's position, not the caller", async () => {
    const { client, request } = fakeClient();

    await makeAppHandle(client, "app-1").createSession({
      from: { sessionId: "s-source", entryId: "e-7", inherited: true, anchored: false },
    });

    const params = request.mock.calls[0]![1] as { from?: Record<string, unknown> };
    expect(params.from).not.toHaveProperty("seq");
  });

  it("a root create sends no bag", async () => {
    const { client, request } = fakeClient();

    await makeAppHandle(client, "app-1").createSession();

    const params = request.mock.calls[0]![1] as { from?: unknown; internal?: unknown };
    expect(params.from).toBeUndefined();
    // `internal` is server-declared (Wave A decision) — never lowered from here.
    expect(params.internal).toBeUndefined();
  });
});

describe("list dimensions", () => {
  it("`app/list_sessions` passes the filter opaquely — the new dims need no threading", async () => {
    const { client, request } = fakeClient();
    const filter: SessionFilter = { internal: false, anchored: false };

    await makeAppHandle(client, "app-1").listSessions(filter, { limit: 20 });

    expect(request).toHaveBeenCalledWith("app/list_sessions", {
      appId: "app-1",
      filter,
      cursor: undefined,
      limit: 20,
    });
  });
});

describe("relation() reaches a client through this package", () => {
  it("folds every row of the ADR's table", () => {
    expect(relation({})).toBe("conversation");
    expect(
      relation({
        from: { sessionId: "s", entryId: "e", seq: 3, inherited: true, anchored: false },
      }),
    ).toBe("fork");
    expect(
      relation({ from: { sessionId: "s", entryId: "e", seq: 3, inherited: true, anchored: true } }),
    ).toBe("reply");
    expect(relation({ internal: true })).toBe("worker");
    expect(
      relation({
        internal: true,
        from: { sessionId: "s", entryId: "e", seq: 3, inherited: true, anchored: false },
      }),
    ).toBe("forked-worker");
  });
});
