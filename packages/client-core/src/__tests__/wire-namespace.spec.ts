/**
 * #248 — PER-METHOD namespace merge. A registered sub-handle used to remove its
 * WHOLE wire namespace from `session.*`: a row the handle didn't mirror was
 * unreachable except through raw `client.request` (that is how `timeline/compact`
 * shipped with a gateway handler, e2e coverage, and no way to call it). The
 * sub-handle is now wrapped in a fallthrough proxy — its own members win, the
 * namespace's declared leftovers synthesize the wire call.
 *
 * The CRITICAL LAW pinned here: a handle-defined method ALWAYS wins over a
 * same-named wire row. `state.get` / `skills.get` / `prompts.get` are sync
 * snapshot reads; the async rows behind them stay shadowed, deliberately.
 */

import { describe, expect, it, vi } from "vitest";

import { makeSessionHandle } from "../handles.js";
import { registerSessionHandleExtension } from "../session-handle-extensions.js";
import { isEnumerable, isRespondable } from "../handle-contract.js";
import { wireFallthrough } from "../wire-namespace.js";

type InternalClientArg = Parameters<typeof makeSessionHandle>[0];

function fakeClient() {
  const request = vi.fn(async () => "wire-result");
  const client = { id: "c1", request, transport: {} } as unknown as InternalClientArg;
  return { client, request };
}

/** The runtime is a superset of the mapped type; probe slots by name. */
function slot(session: object, name: string): Record<string, unknown> {
  return (session as unknown as Record<string, Record<string, unknown>>)[name];
}

/**
 * `wireFallthrough` is type-PRESERVING by design — the per-method merge lives on
 * `SessionHandle` in `@agentick/spec` (pinned by `wire-proxy.type.spec.ts`), not
 * on the runtime helper. Probe the synthesized rows by name.
 */
type WireRow = ((params?: Record<string, unknown>) => Promise<unknown>) | undefined;
function row(handle: object, name: string): WireRow {
  return (handle as unknown as Record<string, WireRow>)[name];
}

describe("wireFallthrough — precedence", () => {
  const { client, request } = fakeClient();
  const handle = {
    // Same NAME as a declared wire row, DIFFERENT contract: a sync snapshot read.
    get: (id: string) => ({ id, from: "snapshot" }),
    subscribe: () => () => undefined,
    close: () => undefined,
  };
  const wrapped = wireFallthrough(handle, client, "s1", "billing", ["approve", "get", "commands"]);

  it("the handle's own member wins over a same-named wire row (the law)", () => {
    expect(wrapped.get("o-1")).toEqual({ id: "o-1", from: "snapshot" });
    expect(request).not.toHaveBeenCalled();
  });

  it("a declared leftover row synthesizes the bound wire call", async () => {
    await expect(row(wrapped, "approve")!({ orderId: "o-9" })).resolves.toBe("wire-result");
    expect(request).toHaveBeenCalledWith("billing/approve", { sessionId: "s1", orderId: "o-9" });
  });

  it("synthesizes with only the bound sessionId when called with no params", async () => {
    await row(wrapped, "commands")!();
    expect(request).toHaveBeenCalledWith("billing/commands", { sessionId: "s1" });
  });

  it("an UNDECLARED name is `undefined` — feature detection stays honest", () => {
    expect(row(wrapped, "refund")).toBeUndefined();
    // The reason the allow-list exists: blind synthesis would make every handle
    // duck-type as Respondable, and generic tooling binds on exactly that.
    expect(isRespondable(wrapped)).toBe(false);
    expect(isEnumerable(wrapped)).toBe(false); // `list` is neither owned nor declared
  });

  it("member identity is stable — `useSyncExternalStore` must not resubscribe", () => {
    expect(wrapped.subscribe).toBe(wrapped.subscribe); // memoized binding
    expect(row(wrapped, "approve")).toBe(row(wrapped, "approve")); // memoized synthesis
  });

  it("a live getter is re-read on every access (not frozen by the memo)", () => {
    let n = 0;
    const counting = wireFallthrough(
      {
        get next() {
          return ++n;
        },
      },
      client,
      "s1",
      "billing",
      ["approve"],
    );
    expect(counting.next).toBe(1);
    expect(counting.next).toBe(2);
  });

  it("`in` agrees with `get` — own members and declared rows both report present", () => {
    expect("get" in wrapped).toBe(true);
    expect("approve" in wrapped).toBe(true);
    expect("refund" in wrapped).toBe(false);
  });

  it("serves a CLASS handle's prototype methods (the `in` check, not own-keys)", async () => {
    class Handle {
      #secret = "held";
      get(id: string): string {
        return `${this.#secret}:${id}`;
      }
    }
    const proxied = wireFallthrough(new Handle(), client, "s1", "billing", ["approve", "get"]);
    expect(proxied.get("x")).toBe("held:x");
  });
});

describe("session.<slot> — the merge, end to end", () => {
  it("reaches the leftover row while the handle's own methods keep working", async () => {
    // A stand-in for `@agentick/timeline/client`: a rich handle over SOME of the
    // namespace's rows (`history`), leaving `compact` to the wire.
    registerSessionHandleExtension(
      "timelinelike",
      () => ({
        list: () => ["local"],
        history: async () => ({ entries: ["from-handle"] }),
        close: () => undefined,
      }),
      { wireMethods: ["commands", "compact", "history"] },
    );

    const { client, request } = fakeClient();
    const session = makeSessionHandle(client, "s1");
    const timeline = slot(session, "timelinelike");

    // Handle-owned: no wire traffic.
    await expect((timeline.history as () => Promise<unknown>)()).resolves.toEqual({
      entries: ["from-handle"],
    });
    expect(request).not.toHaveBeenCalled();

    // NEWLY REACHABLE: the row the handle never mirrored.
    await (timeline.compact as (p: Record<string, unknown>) => Promise<unknown>)({ keep: 10 });
    expect(request).toHaveBeenCalledWith("timelinelike/compact", { sessionId: "s1", keep: 10 });

    // …and the descriptor read, which no handle mirrors anywhere.
    await (timeline.commands as () => Promise<unknown>)();
    expect(request).toHaveBeenCalledWith("timelinelike/commands", { sessionId: "s1" });
  });

  it("a slot registered WITHOUT wireMethods is handed back unwrapped", () => {
    const built = { marker: "raw", close: () => undefined };
    registerSessionHandleExtension("nofallthrough", () => built);
    const session = makeSessionHandle(fakeClient().client, "s1");
    expect(slot(session, "nofallthrough")).toBe(built);
  });
});
