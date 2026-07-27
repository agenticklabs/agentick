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
