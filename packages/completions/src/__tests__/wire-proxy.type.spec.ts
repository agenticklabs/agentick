/**
 * TYPE-LEVEL conformance for the client surface of `completions/complete`.
 *
 * There is no hand-written client handle to test, and that is the claim: the
 * `WireMethods` row in `../wire-augment.ts` is the ONLY input, and
 * `session.completions.complete(params-minus-sessionId)` falls out of it typed
 * end to end. These assertions are what break CI if a future refactor regresses
 * that derivation (`spec/src/__tests__/wire-proxy.type.spec.ts` pins the
 * machinery generically; this pins THIS verb).
 *
 * Pinned: the namespace enumerates, `sessionId` is bound out of the caller's
 * params, `ref.type` is a one-member literal union rather than `string` (so
 * `"resource"` is a compile error until the arm exists), the result is the
 * `CompletionResult` currency, and a typo'd method does not exist.
 */

import { describe, expectTypeOf, it } from "vitest";
import type {
  CompletionResult,
  SessionHandle,
  SessionWireNamespace,
  SessionWireNamespaces,
} from "@agentick/spec";

// The row under test — a side-effect import of the type-only augmentation.
import "../wire-augment.js";

type Complete = SessionWireNamespaces["completions"]["complete"];
type CompleteParams = Parameters<Complete>[0];

describe("session.completions.complete — the derived client surface", () => {
  it("enumerates `completions` as a session-scoped wire namespace", () => {
    expectTypeOf<"completions" extends SessionWireNamespace ? true : false>().toEqualTypeOf<true>();
  });

  it("binds `sessionId` out and keeps the rest of the row's params", () => {
    expectTypeOf<CompleteParams>().toEqualTypeOf<{
      ref: { readonly type: "prompt"; readonly name: string };
      argument: { readonly name: string; readonly value: string };
      context?: { readonly arguments: Readonly<Record<string, string>> };
    }>();
    // The handle carries addressing — a caller passing `sessionId` is an error.
    expectTypeOf<CompleteParams>().not.toHaveProperty("sessionId");
  });

  it("answers the CompletionResult currency", () => {
    expectTypeOf<Awaited<ReturnType<Complete>>>().toEqualTypeOf<CompletionResult>();
  });

  it("types `ref.type` as a literal union, not a string", () => {
    expectTypeOf<CompleteParams["ref"]["type"]>().toEqualTypeOf<"prompt">();
    // A future `"resource"` / `"tool"` arm is ADDITIVE — until it exists, naming
    // it is a compile error rather than a runtime 404.
    expectTypeOf<
      string extends CompleteParams["ref"]["type"] ? true : false
    >().toEqualTypeOf<false>();
  });

  it("surfaces the method on a SessionHandle and rejects a typo", () => {
    expectTypeOf<SessionHandle["completions"]["complete"]>().toEqualTypeOf<Complete>();
    // @ts-expect-error — `compleet` is not a `completions/*` row; the mapped type is the guard.
    type _Typo = SessionHandle["completions"]["compleet"];
  });
});
