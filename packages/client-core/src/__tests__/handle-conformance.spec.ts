/**
 * Proves `runClientHandleConformance` ITSELF — it exercises a MINIMAL FAKE
 * handle that implements the full contract (core + Enumerable + Respondable +
 * two derived write verbs) over a `spyClientTransport`. When the real handles
 * converge onto the contract (rollout slices 3+), they run the same suite; this
 * self-test guarantees the suite is a real gate and not a no-op.
 *
 * The fake also carries EXTRA members (`respondedLog`, item `label`) the suite
 * never asserts about — a live demonstration of principle #4 (contracts are
 * floors, not ceilings): satisfying the shape IS conforming, and a handle may
 * carry anything else.
 */

import { describe, expect, it } from "vitest";

import { isClientHandle, isEnumerable, isRespondable } from "../handle-contract.js";
import type { ClientHandle, Enumerable, Respondable } from "../handle-contract.js";
import { runClientHandleConformance } from "../testing/handle-conformance.js";
import { spyClientTransport, type SpyClientTransport } from "../testing/spy-client-transport.js";

const CHANNEL = "fake";

interface FakeItem {
  readonly id: string;
  readonly value: number;
  /** Extra field the contract knows nothing about — rides through untouched. */
  readonly label?: string;
}

type FakeFrame =
  | {
      readonly kind: "snapshot";
      readonly items: readonly FakeItem[];
      readonly pending?: readonly string[];
    }
  | { readonly kind: "add"; readonly item: FakeItem }
  | { readonly kind: "pending"; readonly id: string };

interface FakeHandle
  extends ClientHandle, Enumerable<FakeItem>, Respondable<{ readonly ok: boolean }> {
  /** Derived write verb → `fake/set`. */
  set(id: string, value: number): Promise<void>;
  /** An EXTRA member — proves the suite tolerates more than the contract. */
  respondedLog(): readonly { readonly id: string; readonly input: { readonly ok: boolean } }[];
}

function fakeHandle(
  spy: SpyClientTransport,
  opts: {
    readonly responded?: { id: string; input: { ok: boolean } }[];
    readonly sessionId?: string;
  } = {},
): FakeHandle {
  const sessionId = opts.sessionId ?? "s1";
  const responded = opts.responded ?? [];
  const items = new Map<string, FakeItem>();
  const pending = new Set<string>();
  const listeners = new Set<() => void>();
  let closed = false;

  const sub = spy.transport.subscribe(
    { kind: "session", id: sessionId },
    { surface: "session", name: { exact: `session:channel:${CHANNEL}` } },
  );

  const notify = (): void => {
    for (const l of listeners) l();
  };

  void (async () => {
    for await (const frame of sub) {
      if (closed) break;
      const f = frame.envelope.payload as FakeFrame;
      if (f.kind === "snapshot") {
        items.clear();
        for (const it of f.items) items.set(it.id, it);
        for (const p of f.pending ?? []) pending.add(p);
      } else if (f.kind === "add") {
        items.set(f.item.id, f.item);
      } else {
        pending.add(f.id);
      }
      notify();
    }
  })();

  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close(): void {
      closed = true;
      listeners.clear();
      void sub.close();
    },
    list: () => [...items.values()],
    get: (id: string) => items.get(id),
    respond(id: string, input: { ok: boolean }): Promise<void> {
      if (!pending.has(id)) return Promise.reject(new Error(`unknown request "${id}"`));
      pending.delete(id);
      responded.push({ id, input });
      return spy.transport
        .request(
          "session/respond_to_elicitation" as never,
          {
            sessionId,
            correlationId: id,
            outcome: "accepted",
          } as never,
        )
        .then(() => undefined);
    },
    set(id: string, value: number): Promise<void> {
      return spy.transport
        .request("knobs/set" as never, { sessionId, id, value } as never)
        .then(() => undefined);
    },
    respondedLog: () => responded,
  };
}

// ── The self-test: drive the suite against the fake ─────────────────────────

let itemSeq = 0;

runClientHandleConformance<FakeHandle, FakeItem, string, { ok: boolean }>({
  label: "minimal fake handle",
  setup() {
    const spy = spyClientTransport();
    const handle = fakeHandle(spy);
    return {
      handle,
      // Each change adds a UNIQUE item so the coherence case can see list() move.
      change: () =>
        spy.emit(CHANNEL, { kind: "add", item: { id: `i${++itemSeq}`, value: itemSeq } }),
    };
  },
  enumerable: {
    async connectAfterSeed() {
      const spy = spyClientTransport();
      const handle = fakeHandle(spy);
      // Seed a PRE-CONNECTION item via the opening snapshot frame (mid-ask).
      spy.emit(CHANNEL, { kind: "snapshot", items: [{ id: "pre-1", value: 7, label: "seeded" }] });
      return { handle, id: "pre-1" };
    },
  },
  respondable: {
    sampleInput: { ok: true },
    async withPendingRequest() {
      const spy = spyClientTransport();
      const responded: { id: string; input: { ok: boolean } }[] = [];
      const handle = fakeHandle(spy, { responded });
      spy.emit(CHANNEL, { kind: "pending", id: "req-1" });
      // Wait for the pending frame to fold before handing the handle over.
      await new Promise((r) => setTimeout(r, 5));
      return { handle, id: "req-1", responded: () => responded };
    },
  },
  writeVerbs: [
    {
      verb: "set",
      method: "knobs/set",
      boundAddress: { sessionId: "s1" },
      async run() {
        const spy = spyClientTransport();
        const handle = fakeHandle(spy);
        await handle.set("temperature", 0.9);
        const req = spy.lastRequest()!;
        return { method: req.method, params: req.params };
      },
    },
    {
      verb: "respond",
      method: "session/respond_to_elicitation",
      boundAddress: { sessionId: "s1", correlationId: "req-1" },
      async run() {
        const spy = spyClientTransport();
        const handle = fakeHandle(spy);
        spy.emit(CHANNEL, { kind: "pending", id: "req-1" });
        await new Promise((r) => setTimeout(r, 5));
        await handle.respond("req-1", { ok: true });
        const req = spy.lastRequest()!;
        return { method: req.method, params: req.params };
      },
    },
  ],
});

// ── Direct unit coverage of the feature-detection predicates ────────────────

describe("handle-contract feature detection", () => {
  it("isClientHandle / isEnumerable / isRespondable duck-type the fake", () => {
    const handle = fakeHandle(spyClientTransport());
    expect(isClientHandle(handle)).toBe(true);
    expect(isEnumerable(handle)).toBe(true);
    expect(isRespondable(handle)).toBe(true);
  });

  it("reject non-conforming values", () => {
    expect(isClientHandle({})).toBe(false);
    expect(isClientHandle(null)).toBe(false);
    expect(isEnumerable({ list: () => [] })).toBe(false); // missing get
    expect(isRespondable({ respond: 1 })).toBe(false); // not callable
  });

  it("a bare store (subscribe only, no profiles) is a ClientHandle but not Enumerable", () => {
    const bare: ClientHandle = { subscribe: () => () => {} };
    expect(isClientHandle(bare)).toBe(true);
    expect(isEnumerable(bare)).toBe(false);
    expect(isRespondable(bare)).toBe(false);
  });
});
