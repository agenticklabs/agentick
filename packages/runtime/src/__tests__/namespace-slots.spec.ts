/**
 * ADR 93 §"Top-level slots for every namespace" — the runtime half of the slots
 * law: the side-effect registry that lets a config layer forward a namespace's
 * top-level slot WITHOUT naming that namespace (ADR 27 — built-ins are bundled,
 * never privileged).
 *
 * The type half (`NamespaceSlots` augmentation) is verified by compilation: the
 * app-level slot tests in `@agentick/app` would not typecheck if
 * `@agentick/timeline`'s augmentation were missing.
 *
 * @see packages/app/src/__tests__/genesis-lifecycle.spec.tsx — the end-to-end slot proof
 */

import { describe, expect, it } from "vitest";

import {
  collectNamespaceSlots,
  namespaceSlotExtensions,
  registerNamespaceSlot,
  registeredNamespaceSlots,
} from "../substrate/namespace-slots.js";

describe("namespace slots — the side-effect registry", () => {
  it("registers a slot name and is IDEMPOTENT (double import never duplicates)", () => {
    registerNamespaceSlot("__slot_test__");
    registerNamespaceSlot("__slot_test__");
    const names = registeredNamespaceSlots();
    expect(names.filter((n) => n === "__slot_test__")).toEqual(["__slot_test__"]);
  });

  it("projects ONLY the registered, PRESENT slots out of a config bag", () => {
    registerNamespaceSlot("__slot_a__");
    registerNamespaceSlot("__slot_b__");
    const projected = collectNamespaceSlots({
      __slot_a__: { store: "x" },
      // `__slot_b__` omitted entirely — an absent slot must stay absent so the
      // owning layer's own default applies rather than being overwritten with
      // `undefined`.
      model: "not-a-namespace",
      tools: [],
    });
    expect(Object.keys(projected)).toEqual(["__slot_a__"]);
    expect(projected.__slot_a__).toEqual({ store: "x" });
  });

  it("treats an explicitly-undefined slot as absent", () => {
    registerNamespaceSlot("__slot_c__");
    expect(collectNamespaceSlots({ __slot_c__: undefined })).toEqual({});
  });

  it("never forwards a key that no package registered", () => {
    // The whole point: a config layer forwards namespace slots and nothing else,
    // so an unrelated top-level option can never be mistaken for one.
    const projected = collectNamespaceSlots({ __never_registered__: { store: "x" } });
    expect(projected).toEqual({});
  });
});

describe("namespace slots — the installer arm (ADR 93 D3)", () => {
  it("mints an install for each PRESENT slot that registered a `toExtension`", () => {
    registerNamespaceSlot("__ext_a__", { toExtension: (v) => ({ installed: v }) });
    registerNamespaceSlot("__ext_b__", { toExtension: (v) => ({ installed: v }) });
    const minted = namespaceSlotExtensions({ __ext_a__: { hydrate: "x" } });
    expect(minted).toEqual([{ installed: { hydrate: "x" } }]);
  });

  it("skips a HOST-CONSTRUCTED slot — one with no `toExtension` mints nothing", () => {
    // The timeline's shape: the session builds it for its required bridge set, so
    // the slot needs a name only and the owning layer reads the value out of
    // `collectNamespaceSlots` instead.
    registerNamespaceSlot("__host_built__");
    expect(namespaceSlotExtensions({ __host_built__: { store: "x" } })).toEqual([]);
    expect(collectNamespaceSlots({ __host_built__: { store: "x" } })).toEqual({
      __host_built__: { store: "x" },
    });
  });

  it("mints in REGISTRATION order, so the install order is stable", () => {
    registerNamespaceSlot("__ext_first__", { toExtension: () => "first" });
    registerNamespaceSlot("__ext_second__", { toExtension: () => "second" });
    const minted = namespaceSlotExtensions({ __ext_second__: {}, __ext_first__: {} });
    expect(minted).toEqual(["first", "second"]);
  });

  it("an absent or explicitly-undefined slot mints nothing", () => {
    registerNamespaceSlot("__ext_absent__", { toExtension: () => "nope" });
    expect(namespaceSlotExtensions({})).not.toContain("nope");
    expect(namespaceSlotExtensions({ __ext_absent__: undefined })).not.toContain("nope");
  });

  it("a later registration may SUPPLY the installer arm a bare earlier one lacked", () => {
    // Module-evaluation order is not something a package controls, so a repeat
    // registration must be able to upgrade a name-only slot rather than being
    // silently dropped by idempotency.
    registerNamespaceSlot("__ext_upgrade__");
    expect(namespaceSlotExtensions({ __ext_upgrade__: {} })).toEqual([]);
    registerNamespaceSlot("__ext_upgrade__", { toExtension: () => "upgraded" });
    expect(namespaceSlotExtensions({ __ext_upgrade__: {} })).toEqual(["upgraded"]);
  });

  it("never DOWNGRADES an existing installer arm", () => {
    registerNamespaceSlot("__ext_keep__", { toExtension: () => "kept" });
    registerNamespaceSlot("__ext_keep__");
    expect(namespaceSlotExtensions({ __ext_keep__: {} })).toEqual(["kept"]);
  });
});
