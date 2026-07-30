/**
 * TYPE-LEVEL conformance for the session WIRE PROXY (B2 slice 4). These pin the
 * IntelliSense contract (Ryan 2026-07-22) so it breaks CI, not vibes, if a future
 * refactor regresses it:
 *
 *   - namespace ENUMERATION: `session.` autocompletes exactly the session-scoped
 *     wire namespaces (`billing`, `testns`, …) and NOT `gateway`/`app`/`session`;
 *   - per-row PARAM + RESULT inference (sessionId bound out of params);
 *   - typo = COMPILE ERROR (`@ts-expect-error`);
 *   - NO index signature / `Record<string, Fn>` / `(string & {})` escape hatch
 *     polluting the key set (that would collapse autocomplete to "any string").
 *
 * A module augmentation supplies two example verticals, exactly as an adopter
 * would (the guide §1 shape). Because it augments the package under test, these
 * namespaces are visible to the derived types here.
 *
 * @see docs/proposals/v2/guide-wire-and-client.md §1
 * @see docs/proposals/v2/client-handles.md §"SLICE-4 SPEC v2"
 */

import { describe, expectTypeOf, it } from "vitest";
import type {
  SessionHandle,
  SessionWireNamespace,
  SessionWireNamespaces,
} from "../client/index.js";

declare module "../wire/params.js" {
  interface WireMethods {
    // The guide §1 vertical — a session-scoped namespace with a bound sessionId.
    "billing/approve": {
      params: { sessionId: string; orderId: string };
      result: { ok: boolean };
    };
    // A second namespace, for enumeration assertions.
    "testns/doThing": {
      params: { sessionId: string; count: number };
      result: { echoed: number };
    };
    // A namespace a rich sub-handle CLAIMS below — three rows, one of which the
    // handle mirrors under the same name with a different contract.
    "merged/get": { params: { sessionId: string; id: string }; result: { row: string } };
    "merged/compact": { params: { sessionId: string; keep: number }; result: { removed: number } };
    "merged/commands": { params: { sessionId: string }; result: readonly string[] };
  }
}

/** The rich sub-handle a harness `/client` contributes for `merged` (ADR 87). */
interface MergedClientHandle {
  /** SYNC snapshot read — the same NAME as `merged/get`, a different contract. */
  get(id: string): { row: string; from: "snapshot" } | undefined;
  close(): void;
}

declare module "../client/handles.js" {
  interface SessionHandleExtensions {
    readonly merged: MergedClientHandle;
    /** A slot with NO wire namespace of its own — it must ride through as-is. */
    readonly slotOnly: { readonly marker: "no-wire-namespace" };
  }
}

/** `true`/`false` helper — keeps the assertions readable. */
type Has<NS extends string> = NS extends SessionWireNamespace ? true : false;

describe("session wire proxy — type-level IntelliSense contract", () => {
  it("enumerates session-scoped namespaces; excludes non-session ones", () => {
    // Augmented session-scoped namespaces enumerate (autocomplete on `session.`).
    expectTypeOf<Has<"billing">>().toEqualTypeOf<true>();
    expectTypeOf<Has<"testns">>().toEqualTypeOf<true>();
    // `session/*` rows are the session handle's OWN methods — NOT a `session.session`.
    expectTypeOf<Has<"session">>().toEqualTypeOf<false>();
    // `gateway/*` / `app/*` carry no sessionId — never session-addressable.
    expectTypeOf<Has<"gateway">>().toEqualTypeOf<false>();
    expectTypeOf<Has<"app">>().toEqualTypeOf<false>();
  });

  it("has NO index signature — the key set is a finite union, not `string`", () => {
    // If an index signature (or `Record<string, …>`) leaked in, `string` would
    // extend the keys and autocomplete would collapse. It must NOT.
    expectTypeOf<
      string extends keyof SessionWireNamespaces ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      string extends keyof SessionWireNamespaces["billing"] ? true : false
    >().toEqualTypeOf<false>();
  });

  it("infers params (sessionId bound out) and result from the row", () => {
    type ApproveParams = Parameters<SessionWireNamespaces["billing"]["approve"]>[0];
    type ApproveResult = Awaited<ReturnType<SessionWireNamespaces["billing"]["approve"]>>;
    // sessionId is bound by the handle — it is projected OUT of the caller params.
    expectTypeOf<ApproveParams>().toEqualTypeOf<{ orderId: string }>();
    expectTypeOf<ApproveResult>().toEqualTypeOf<{ ok: boolean }>();

    type DoThingParams = Parameters<SessionWireNamespaces["testns"]["doThing"]>[0];
    expectTypeOf<DoThingParams>().toEqualTypeOf<{ count: number }>();
  });

  it("surfaces the methods on a SessionHandle, typed end-to-end", () => {
    // Type-level indexing only (no runtime access on the `{}`-backed value).
    type Approve = SessionHandle["billing"]["approve"];
    expectTypeOf<Approve>().toEqualTypeOf<
      (params: { orderId: string }) => Promise<{ ok: boolean }>
    >();
    // Round-trip return type flows to the caller.
    expectTypeOf<Awaited<ReturnType<Approve>>>().toEqualTypeOf<{ ok: boolean }>();
  });

  it("rejects a typo'd method / unknown namespace at compile time (not a 404)", () => {
    // @ts-expect-error — `aprove` is not a `billing/*` row; the mapped type is the guard.
    type _Typo = SessionHandle["billing"]["aprove"];
    // @ts-expect-error — `nope` is not a session-scoped namespace at all.
    type _NoNs = SessionHandle["nope"];
  });
});

/**
 * #248 — a claimed namespace merges PER METHOD. Registering a rich sub-handle
 * used to `Omit` the whole namespace, so every row the handle didn't mirror fell
 * off `session.*` (the shipped-but-uncallable `timeline/compact`).
 */
describe("session handle — per-method merge of a claimed namespace", () => {
  it("keeps the handle's OWN members", () => {
    expectTypeOf<SessionHandle["merged"]["close"]>().toEqualTypeOf<() => void>();
  });

  it("THE LAW: a handle method wins over a same-named wire row", () => {
    // `merged/get` is `(params: { id: string }) => Promise<{ row: string }>`; the
    // handle's sync snapshot read is what survives the merge. Same name, different
    // contract — the row stays shadowed, deliberately (state/skills/prompts `get`).
    expectTypeOf<SessionHandle["merged"]["get"]>().toEqualTypeOf<
      (id: string) => { row: string; from: "snapshot" } | undefined
    >();
  });

  it("the namespace's UNMIRRORED rows fall through, typed from the row", () => {
    expectTypeOf<SessionHandle["merged"]["compact"]>().toEqualTypeOf<
      (params: { keep: number }) => Promise<{ removed: number }>
    >();
    expectTypeOf<SessionHandle["merged"]["commands"]>().toEqualTypeOf<
      (params: Record<never, never>) => Promise<readonly string[]>
    >();
  });

  it("a sub-handle slot with no wire namespace rides through untouched", () => {
    expectTypeOf<SessionHandle["slotOnly"]>().toEqualTypeOf<{
      readonly marker: "no-wire-namespace";
    }>();
  });

  it("still rejects a name that is neither a handle member nor a row", () => {
    // @ts-expect-error — `merged/purge` does not exist and the handle has no `purge`.
    type _Nope = SessionHandle["merged"]["purge"];
  });
});
