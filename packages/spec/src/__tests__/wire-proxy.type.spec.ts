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
