/**
 * `runClientHandleConformance` — the client twin of spec-conformance's store
 * suite, structured exactly like `runStoreConformance` (`@agentick/store`):
 * a thin mandatory CORE that every handle runs, plus PROFILE cases that run iff
 * the caller declares that profile (by supplying its probe). A handle written
 * next year passes this suite or it does not ship — coherence becomes a property
 * of CI, not of review-time vigilance (B2 §4).
 *
 * ## What it pins — and what it deliberately does NOT
 *
 * It asserts that the REQUIRED members BEHAVE:
 *   - Core: `subscribe` fires on change, the callback takes NO arguments, the
 *     returned `Unsubscribe` stops it, and `close()` (when present) tears down.
 *   - Enumerable: `list()` reflects PRE-CONNECTION state (the mid-ask shape —
 *     each handle supplies its own "seed then connect" closure), `get(id)`, and
 *     list/subscribe coherence (the state read inside the listener is the
 *     post-change state).
 *   - Respondable: `respond` routes by id, an unknown id rejects, double-respond
 *     is defined (settles — never hangs).
 *   - Write verbs: every declared verb hits its wire method with correctly bound
 *     addressing (the derived-from-wire check, via a spy transport).
 *
 * It NEVER asserts exact shape, no-extra-keys, or "only these members"
 * (principle #4 — contracts are floors, not ceilings): a handle carrying ten
 * extra user methods and items with extra fields passes unchanged. Every
 * params/state check is a SUBSET match (`toMatchObject`), never `toEqual`.
 *
 * @see docs/proposals/v2/client-handles.md §4
 * @see runStoreConformance — the structural sibling this mirrors
 */

import { describe, expect, it } from "vitest";
import { waitFor } from "@agentick/utils/testing";

import {
  isEnumerable,
  isRespondable,
  type ClientHandle,
  type Enumerable,
  type Respondable,
} from "../handle-contract.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** Fresh handle + a driver that causes its state/feed to change (core cases). */
export interface ClientHandleConformanceContext<H extends ClientHandle> {
  readonly handle: H;
  /**
   * Cause the handle's state/feed to change. For an Enumerable handle this MUST
   * add/alter an item (so the coherence case can observe `list()` move). May be
   * sync or async.
   */
  readonly change: () => void | Promise<void>;
  /** Extra scaffolding teardown beyond `handle.close()` (e.g. end a fake feed). */
  readonly teardown?: () => void | Promise<void>;
}

/** Probe supplying the {@link Enumerable} profile's parameterized closures. */
export interface EnumerableProbe<H extends ClientHandle, T = unknown, Id = string> {
  /**
   * Seed a pre-existing item into the backing BEFORE the handle connects, then
   * build & return the handle plus the id addressing that item. Models a client
   * connecting mid-ask: `list()` must reflect the pre-connection item.
   */
  readonly connectAfterSeed: () => Promise<{
    readonly handle: H & Enumerable<T, Id>;
    readonly id: Id;
    readonly teardown?: () => void | Promise<void>;
  }>;
  /** An id known to be absent (`get()` → `undefined`). Defaults to a sentinel. */
  readonly absentId?: Id;
}

/** Probe supplying the {@link Respondable} profile's parameterized closures. */
export interface RespondableProbe<H extends ClientHandle, In = unknown> {
  /**
   * Build a handle with one pending request already in flight; return the
   * handle, the id addressing it, and a spy reporting the routed responses.
   */
  readonly withPendingRequest: () => Promise<{
    readonly handle: H & Respondable<In>;
    readonly id: string;
    // The suite asserts only that the reply was ROUTED by id (`toMatchObject
    // [{ id }]`) — a probe may report more, but need only surface the id.
    readonly responded: () => readonly { readonly id: string }[];
    readonly teardown?: () => void | Promise<void>;
  }>;
  /** A sample input to respond with. */
  readonly sampleInput: In;
  /** An id known to be unknown (`respond` → rejects). Defaults to a sentinel. */
  readonly unknownId?: string;
  /**
   * OPTIONAL — for REQUEST-SHAPED Enumerables whose `list()` yields ITEM HANDLES
   * (data + bound verbs), not bare data (Ryan 2026-07-22). The canonical
   * acceptance case: a client connecting MID-ASK sees the pending request via
   * `list()`, and calling the LISTED item's bound verb (`item.accept(value)` /
   * `item.respond(result)`) round-trips to the server and resolves the pending
   * op — proving the item handle is constructed IDENTICALLY whether the request
   * arrived via the slice-2 snapshot frame or a live delta (one constructor,
   * both sources). Supplied by `session.elicitations` / `session.clientToolCalls`;
   * omitted by data-only Enumerables (knobs/tasks).
   */
  readonly listedItemRoundTrip?: {
    /**
     * Build a handle with ONE pending request seeded via the SNAPSHOT
     * (pre-connection) path, so `list()`/`get(id)` reflect it before any live
     * delta. Return the handle, the id addressing the pending request, and a spy
     * reporting responses routed to the server.
     */
    readonly connect: () => Promise<{
      readonly handle: H & Enumerable<unknown>;
      readonly id: string;
      readonly responded: () => readonly { readonly id: string }[];
      readonly teardown?: () => void | Promise<void>;
    }>;
    /** Invoke the LISTED item handle's bound verb (e.g. `item.accept(value)`). */
    readonly invoke: (item: unknown) => Promise<void>;
  };
}

/** Probe for one derived write verb — the derived-from-wire check. */
export interface WriteVerbProbe {
  /** Human name of the verb (test label). */
  readonly verb: string;
  /** The wire method the verb MUST hit. */
  readonly method: string;
  /**
   * Build a handle over a spy transport, invoke the verb, and return the wire
   * request the verb issued. Use {@link spyClientTransport} for the spy.
   */
  readonly run: () => Promise<{ readonly method: string; readonly params: unknown }>;
  /**
   * Address keys the params MUST carry (SUBSET match — e.g. `{ sessionId }`).
   * Never an exhaustive shape: extra params are allowed (principle #4).
   */
  readonly boundAddress?: Readonly<Record<string, unknown>>;
}

export interface ClientHandleConformanceOptions<
  H extends ClientHandle,
  T = unknown,
  Id = string,
  In = unknown,
> {
  /** Suite label (`describe` block heading). */
  readonly label: string;
  /** Skip the whole suite (registers it as skipped). */
  readonly skip?: boolean;
  /** Fresh handle + `change()` driver, per `it`. */
  readonly setup: () =>
    | ClientHandleConformanceContext<H>
    | Promise<ClientHandleConformanceContext<H>>;
  /** Declared {@link Enumerable} profile cases (run iff present). */
  readonly enumerable?: EnumerableProbe<H, T, Id>;
  /** Declared {@link Respondable} profile cases (run iff present). */
  readonly respondable?: RespondableProbe<H, In>;
  /** Declared derived write-verb cases. */
  readonly writeVerbs?: readonly WriteVerbProbe[];
}

export function runClientHandleConformance<
  H extends ClientHandle,
  T = unknown,
  Id = string,
  In = unknown,
>(opts: ClientHandleConformanceOptions<H, T, Id, In>): void {
  const suite = opts.skip ? describe.skip : describe;

  suite(`ClientHandle conformance — ${opts.label}`, () => {
    // ─── Core (mandatory) ─────────────────────────────────────────────────

    it("subscribe fires on change; the callback receives NO arguments", async () => {
      const { handle, change, teardown } = await opts.setup();
      let fired = 0;
      let argCount = -1;
      const unsub = handle.subscribe((...args: unknown[]) => {
        fired++;
        argCount = args.length;
      });
      await Promise.resolve(change());
      await waitFor(() => fired > 0);
      expect(fired).toBeGreaterThan(0);
      expect(argCount).toBe(0); // the store contract: cb takes no args, read via list()
      unsub();
      handle.close?.();
      await teardown?.();
    });

    it("the returned Unsubscribe stops further notifications", async () => {
      const { handle, change, teardown } = await opts.setup();
      let count = 0;
      const unsub = handle.subscribe(() => count++);
      await Promise.resolve(change());
      await waitFor(() => count === 1);
      unsub();
      await Promise.resolve(change());
      await tick();
      expect(count).toBe(1); // no notification after Unsubscribe
      handle.close?.();
      await teardown?.();
    });

    it("close() tears down the subscription (when the handle owns one)", async () => {
      const { handle, change, teardown } = await opts.setup();
      if (typeof handle.close !== "function") {
        // Optional member — a handle that owns no subscription omits it.
        expect(handle.close).toBeUndefined();
        await teardown?.();
        return;
      }
      let count = 0;
      handle.subscribe(() => count++);
      handle.close();
      await Promise.resolve(change());
      await tick();
      expect(count).toBe(0); // torn down — the change no longer notifies
      await teardown?.();
    });

    it("required read members are extraction-safe — bare subscribe/list survive destructuring (no this-dependence)", async () => {
      const { handle, teardown } = await opts.setup();
      // A consumer commonly destructures the observe/read surface off the handle
      // (`const { subscribe, list } = handle`) or hands a method to a framework
      // as a bare callback. In strict-mode ESM a detached call has
      // `this === undefined`, so a member that reads `this` throws HERE — this
      // probe pins this-independence, the property that makes the surface safe to
      // spread/destructure. Runs for EVERY conformer.
      const { subscribe } = handle;
      const un = subscribe(() => {});
      expect(typeof un).toBe("function");
      un(); // the returned Unsubscribe is itself this-independent
      if (isEnumerable(handle)) {
        const { list, get } = handle;
        expect(list()).toBeDefined();
        expect(() => get("id:never-seen" as never)).not.toThrow();
      }
      handle.close?.();
      await teardown?.();
    });

    // ─── Enumerable (iff declared) ────────────────────────────────────────

    if (opts.enumerable) registerEnumerableCases(opts.enumerable);

    // ─── Respondable (iff declared) ───────────────────────────────────────

    if (opts.respondable) registerRespondableCases(opts.respondable);

    // ─── Write verbs (derived-from-wire) ──────────────────────────────────

    for (const probe of opts.writeVerbs ?? []) registerWriteVerbCase(probe);
  });
}

function registerEnumerableCases<H extends ClientHandle, T, Id>(
  probe: EnumerableProbe<H, T, Id>,
): void {
  it("list() reflects PRE-CONNECTION state (the mid-ask shape)", async () => {
    const { handle, teardown } = await probe.connectAfterSeed();
    expect(isEnumerable(handle)).toBe(true); // typed declaration + runtime detect agree
    await waitFor(() => handle.list().length > 0);
    expect(handle.list().length).toBeGreaterThan(0);
    handle.close?.();
    await teardown?.();
  });

  it("get(id) returns the seeded item; an unknown id → undefined", async () => {
    const { handle, id, teardown } = await probe.connectAfterSeed();
    await waitFor(() => handle.list().length > 0);
    expect(handle.get(id)).toBeDefined();
    const absent = probe.absentId ?? ("id:never-seen" as unknown as Id);
    expect(handle.get(absent)).toBeUndefined();
    handle.close?.();
    await teardown?.();
  });
}

function registerRespondableCases<H extends ClientHandle, In>(
  probe: RespondableProbe<H, In>,
): void {
  it("respond(id, input) routes the reply to the addressed request", async () => {
    const { handle, id, responded, teardown } = await probe.withPendingRequest();
    expect(isRespondable(handle)).toBe(true); // typed declaration + runtime detect agree
    await handle.respond(id, probe.sampleInput);
    const routed = responded();
    expect(routed.some((r) => r.id === id)).toBe(true);
    expect(routed).toMatchObject([{ id }]); // subset — never asserts extra fields absent
    handle.close?.();
    await teardown?.();
  });

  it("respond() to an unknown id rejects", async () => {
    const { handle, teardown } = await probe.withPendingRequest();
    const unknown = probe.unknownId ?? "id:never-seen";
    await expect(handle.respond(unknown, probe.sampleInput)).rejects.toBeDefined();
    handle.close?.();
    await teardown?.();
  });

  it("double-respond is defined (settles — never hangs)", async () => {
    const { handle, id, teardown } = await probe.withPendingRequest();
    await handle.respond(id, probe.sampleInput);
    // The second reply to an already-answered id must SETTLE deterministically
    // (resolve or reject) — the contract forbids a hang. We assert it settles.
    const settled = await handle
      .respond(id, probe.sampleInput)
      .then(() => "settled")
      .catch(() => "settled");
    expect(settled).toBe("settled");
    handle.close?.();
    await teardown?.();
  });

  // The acceptance case (Ryan 2026-07-22, north-star §1's dialog-button line):
  // a LISTED item handle carries its bound verbs, and they round-trip the same
  // whether the item arrived via the snapshot frame (pending, pre-connection) or
  // a live delta. Runs iff the handle yields item handles from `list()`.
  if (probe.listedItemRoundTrip) registerListedItemRoundTripCase(probe.listedItemRoundTrip);
}

function registerListedItemRoundTripCase(
  probe: NonNullable<RespondableProbe<ClientHandle>["listedItemRoundTrip"]>,
): void {
  it("a LISTED pending item's bound verb round-trips (connect mid-ask → item.accept())", async () => {
    const { handle, id, responded, teardown } = await probe.connect();
    // list() reflects the PRE-CONNECTION pending ask (snapshot-first).
    await waitFor(() => handle.list().length > 0);
    const item = handle.get(id);
    expect(item).toBeDefined(); // the listed item is a handle addressed by id
    await probe.invoke(item); // e.g. item.accept(value) — the dialog-button line
    await waitFor(() => responded().some((r) => r.id === id));
    expect(responded().some((r) => r.id === id)).toBe(true);
    handle.close?.();
    await teardown?.();
  });
}

function registerWriteVerbCase(probe: WriteVerbProbe): void {
  it(`write verb '${probe.verb}' hits wire method '${probe.method}' with bound addressing`, async () => {
    const { method, params } = await probe.run();
    expect(method).toBe(probe.method);
    if (probe.boundAddress) {
      // SUBSET match — the verb may shape extra params; we pin only the address.
      expect(params).toMatchObject(probe.boundAddress);
    }
  });
}
