/**
 * `knobsHandle` — the client-side knobs resource handle, on the unified
 * `ClientHandle` contract (B2 slice 3, `docs/proposals/v2/client-handles.md`).
 *
 * The knobs handle is nouns + verbs over one session's knob state:
 *   - CORE — `subscribe(cb)` (the zero-arg store contract) + `close()`.
 *   - {@link Enumerable} — `list()` returns the current knob DESCRIPTORS+values
 *     (friction #1: it consumes the `descriptors` field slice 2 put on the
 *     `knobs-state` snapshot, so a client renders labels/ranges/enums with no
 *     second round-trip), `get(id)` looks one knob up by id.
 *   - WRITE — `set(id, value)` over `knobs/set` (friction #13: the param is `id`,
 *     one name client-to-server, no `key`→`id` rename at the boundary).
 *
 * Read is a keyed replace-fold over the `knobs-state` channel: the opening
 * snapshot seeds descriptors+values; each delta JSON-Patches the values doc.
 * `list()` materializes descriptors with their current value on every folded
 * frame, so its reference is stable between changes (the `useSyncExternalStore`
 * contract) and always reflects "current state, including what happened before I
 * connected" — the live-only fix.
 *
 * The write is fire-and-observe: `set` issues the RPC and resolves `void`; it
 * does NOT hand-patch the local view — the effect returns as a `knobs-state`
 * delta on the same channel and re-folds the view (CQRS: one write path, one
 * read path). `subscribe(cb)` wraps the internal fold's state feed and invokes
 * `cb` with NO arguments (the dual-feed `onChange` frame-tap survives only
 * inside the fold — client-handles §3).
 *
 * @verifiedBy packages/knobs/src/client/__tests__/knobs-handle.spec.ts
 * @verifiedBy packages/knobs/src/client/__tests__/knobs-handle.conformance.spec.ts
 */

import { channelView, type ClientHandle, type Enumerable } from "@agentick/client-core";
import type {
  ClientMiddleware,
  KnobPrimitive,
  SubscriptionScope,
  Unsubscribe,
} from "@agentick/spec";
import { applyJsonPatch } from "@agentick/utils";

import { KNOBS_STATE_CHANNEL, type KnobsStateFrame, type WireKnobDescriptor } from "../channel.js";
import type { KnobsCommandClient } from "./knobs-state-view.js";

/**
 * The knobs resource handle: the {@link Enumerable} descriptor view (`list` /
 * `get`) + the store-contract `subscribe` + the `set(id, value)` write command.
 * A plain structural shape (floors, not ceilings) — it MAY carry more.
 */
export interface KnobsHandle extends ClientHandle, Enumerable<WireKnobDescriptor> {
  /** The current knobs as DESCRIPTORS+values (id, value, declared metadata). */
  list(): readonly WireKnobDescriptor[];
  /** Look one knob up by id; `undefined` when absent. */
  get(id: string): WireKnobDescriptor | undefined;
  /**
   * Set a knob's value. Issues `knobs/set` ({ sessionId, id, value }) and
   * resolves once the gateway accepts it; the resulting value lands on the view
   * as a `knobs-state` delta (CQRS — no local hand-patch).
   */
  set(id: string, value: KnobPrimitive): Promise<void>;
  /**
   * Register a {@link ClientMiddleware} scoped to THIS handle's wire namespace
   * (`knobs/*`) — sugar over `client.use(...)` that fires only for the knobs
   * verbs (B2 slice 4 §7). Returns an {@link Unsubscribe}. An inert no-op when
   * the handle was minted off a bare-transport double (no `client.use`).
   */
  use(middleware: ClientMiddleware): Unsubscribe;
  /** Tear down the underlying `knobs-state` subscription. */
  close(): void;
}

/** Materialized fold state: the current values doc + descriptors, plus the
 * derived list/by-id snapshot `list()`/`get()` read (ref-stable per frame). */
interface KnobsFold {
  readonly values: Readonly<Record<string, KnobPrimitive>>;
  readonly meta: Readonly<Record<string, WireKnobDescriptor>>;
  readonly list: readonly WireKnobDescriptor[];
  readonly byId: ReadonlyMap<string, WireKnobDescriptor>;
}

/** Merge descriptors with the authoritative values doc into the read snapshot. */
function materialize(
  values: Readonly<Record<string, KnobPrimitive>>,
  meta: Readonly<Record<string, WireKnobDescriptor>>,
): KnobsFold {
  const ids = new Set<string>([...Object.keys(meta), ...Object.keys(values)]);
  const list: WireKnobDescriptor[] = [];
  for (const id of ids) {
    const descriptor = meta[id];
    const value = id in values ? values[id] : descriptor?.value;
    // A knob present only in the values doc (a delta ahead of its descriptor)
    // still enumerates — a minimal { id, value } descriptor (floors, not ceilings).
    list.push(descriptor ? { ...descriptor, value } : { id, value });
  }
  return { values, meta, list, byId: new Map(list.map((d) => [d.id, d])) };
}

const EMPTY: KnobsFold = materialize({}, {});

/**
 * A live read+write handle over `session`'s knob state. The read half opens with
 * the current snapshot (descriptors+values) and folds `knobs-state` deltas; the
 * write half issues `knobs/set`.
 */
export function knobsHandle(client: KnobsCommandClient, sessionId: string): KnobsHandle {
  const scope: SubscriptionScope = { kind: "session", id: sessionId };
  const view = channelView<KnobsFold, KnobsStateFrame>(client, scope, KNOBS_STATE_CHANNEL, {
    initial: EMPTY,
    reduce: (state, frame) => {
      if (frame.kind === "snapshot") {
        const meta = Object.fromEntries(frame.descriptors.map((d) => [d.id, d]));
        return materialize({ ...frame.values }, meta);
      }
      return materialize(applyJsonPatch(state.values, frame.ops), state.meta);
    },
  });

  return {
    list: () => view.get().list,
    get: (id) => view.get().byId.get(id),
    // The store contract: fire on change, hand the callback NO arguments — the
    // caller re-reads via list()/get(). The fold's state value is dropped here.
    subscribe: (cb: () => void): Unsubscribe => view.subscribe(() => cb()),
    close: () => view.close(),
    set: async (id, value) => {
      // Fire-and-observe: the effect returns as a channel delta and re-folds the
      // view (CQRS). Do not patch `view` here. Routes through `transport.request`,
      // which — on a real client — funnels the write through the middleware chain
      // (B2 slice 4), so `client.use(...)` observes `knobs/set`.
      await client.transport.request("knobs/set", { sessionId, id, value });
    },
    // Per-handle middleware: scope a client middleware to the `knobs/*` namespace.
    // Sugar over `client.use` (§7) — inert if the double has no `use`.
    use: (middleware: ClientMiddleware): Unsubscribe => {
      if (!client.use) return () => {};
      return client.use((params, next, ctx) =>
        ctx.method.startsWith("knobs/") ? middleware(params, next, ctx) : next(params),
      );
    },
  };
}
