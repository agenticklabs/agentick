/**
 * TYPE-LEVEL lockstep for the gateway wire hooks (ADR 83 §"Wire dispatch through
 * the seam", Deliverable 1 of "wire extensions are commands").
 *
 * `WireCommandMap` folds every `WireMethods` row into the runtime
 * `CommandRegistry` as a `wire:<method>` op, so `CommandHooks` mints a
 * fully-typed `onBeforeWire<...>` / `onAfterWire<...>` gateway hook per row —
 * for framework rows AND adopter augmentations — with the row's params flowing
 * to the before-hook input and its result to the after-hook output. This file
 * pins the TYPE side; `hook-lifecycle-names.spec.ts` pins the runtime
 * `deriveHookNames` twin (they MUST agree — the Pascal derivation is shared).
 *
 * The assertions are pure `expectTypeOf` — the file exercises no runtime.
 */

import { describe, expectTypeOf, it } from "vitest";
import type { CommandHooks, HookRegistrars } from "../substrate/middleware.js";

// An ADOPTER wire row, added exactly as an adopter would (declaration merge of
// `@agentick/spec`). `wire:crm/deleteContact` Pascalizes to
// `WireCrmDeleteContact` (colon + slash splits; camelCase method segment kept).
declare module "@agentick/spec" {
  interface WireMethods {
    "crm/deleteContact": {
      params: { sessionId: string; contactId: string };
      result: { deleted: boolean };
    };
  }
}

describe("WireCommandMap → CommandHooks (type-level)", () => {
  it("mints a typed gateway hook for an ADOPTER-augmented row", () => {
    // The typed hook name exists on the derived surface.
    expectTypeOf<CommandHooks>().toHaveProperty("onBeforeWireCrmDeleteContact");
    expectTypeOf<CommandHooks>().toHaveProperty("onAfterWireCrmDeleteContact");
  });

  it("flows the row's params into the before-hook input", () => {
    type Before = NonNullable<CommandHooks["onBeforeWireCrmDeleteContact"]>;
    // input (arg 0) is the row's `params` — verbatim, per-field.
    expectTypeOf<Parameters<Before>[0]>().toEqualTypeOf<{
      sessionId: string;
      contactId: string;
    }>();
  });

  it("flows the row's result into the after-hook output", () => {
    type After = NonNullable<CommandHooks["onAfterWireCrmDeleteContact"]>;
    // output (arg 0) is the row's `result`.
    expectTypeOf<Parameters<After>[0]>().toEqualTypeOf<{ deleted: boolean }>();
  });

  it("mints the typed hook for a FRAMEWORK row too (session/send)", () => {
    expectTypeOf<CommandHooks>().toHaveProperty("onBeforeWireSessionSend");
    type Before = NonNullable<CommandHooks["onBeforeWireSessionSend"]>;
    // The framework row's `sessionId` is reachable on the before-hook input.
    expectTypeOf<Parameters<Before>[0]>().toHaveProperty("sessionId");
  });

  it("derives colon+slash+UNDERSCORE names in lockstep with runtime deriveHookNames", () => {
    // `wire:app/run_once` exercises ALL THREE word boundaries the type-level
    // `Pascal` and the runtime `deriveHookNames` split on (`:` `/` `_`). This is
    // a REAL framework row, and `hook-lifecycle-names.spec.ts` pins
    // `deriveHookNames("wire:app/run_once") === ["onBeforeWireAppRunOnce", …]`
    // — same input, both sides → the typed name and the runtime key cannot
    // diverge (not the mangled `…AppRun_once`).
    expectTypeOf<CommandHooks>().toHaveProperty("onBeforeWireAppRunOnce");
    expectTypeOf<CommandHooks>().toHaveProperty("onAfterWireAppRunOnce");
    type Before = NonNullable<CommandHooks["onBeforeWireAppRunOnce"]>;
    expectTypeOf<Parameters<Before>[0]>().toHaveProperty("appId");
  });

  it("the registrar surface (harness.hooks.on…) is typed from the row too", () => {
    // The imperative `gateway.hooks.onBeforeWireCrmDeleteContact(fn)` proxy — the
    // registrar twin of the declarative `CommandHooks` — carries the same typed
    // param, valued as `(fn) => Unsubscribe`.
    expectTypeOf<HookRegistrars>().toHaveProperty("onBeforeWireCrmDeleteContact");
    type Register = HookRegistrars["onBeforeWireCrmDeleteContact"];
    expectTypeOf<Parameters<Parameters<Register>[0]>[0]>().toEqualTypeOf<{
      sessionId: string;
      contactId: string;
    }>();
  });

  it("NO `any` leakage and NO key-widening (the slice-4 index-signature guard)", () => {
    // No `any`: the before-hook input is the exact row type, never `any` — a
    // widened `any` would silently accept anything and kill hover/IntelliSense.
    type BeforeInput = Parameters<NonNullable<CommandHooks["onBeforeWireCrmDeleteContact"]>>[0];
    expectTypeOf<BeforeInput>().not.toBeAny();

    // No key-widening: `string extends keyof CommandHooks` is FALSE — the key set
    // is a finite literal union, so an index signature (`[k: string]: …`) has NOT
    // snuck in via the `WireCommandMap` fold. If one had, `string` would extend
    // the keys and this flips to `true`, breaking exact autocomplete.
    expectTypeOf<string extends keyof CommandHooks ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<string extends keyof HookRegistrars ? true : false>().toEqualTypeOf<false>();
  });

  it("rejects a typo'd hook name (only server-typed rows exist on the surface)", () => {
    // A misspelled verb is NOT a key — the surface is exact, not open.
    expectTypeOf<CommandHooks>().not.toHaveProperty("onBeforeWireCrmDeleteContct");
    // And the UNPREFIXED (client-style) name is NOT a gateway hook — the `Wire`
    // qualifier is mandatory at the gateway boundary (distinct from the client's
    // `onBeforeCrmDeleteContact`, which lives on `ClientHooks`, not here).
    expectTypeOf<CommandHooks>().not.toHaveProperty("onBeforeCrmDeleteContact");
  });
});
