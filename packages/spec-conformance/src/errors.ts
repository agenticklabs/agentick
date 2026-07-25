/**
 * Conformance suite for the `AgentickError` class hierarchy (ADR 41).
 *
 * Pins the invariants every typed error in v2 must satisfy:
 *
 *   1. **Registry inhabitance.** Every tag in `_registeredAgentickErrorTags()`
 *      resolves via `lookupAgentickError(tag)` to a class constructor.
 *   2. **Class hierarchy.** Every registered class is `instanceof
 *      AgentickError` (and therefore `instanceof Error`).
 *   3. **`_tag` agreement.** The class's `_tag` instance property
 *      (set by its field initializer) must equal the registration
 *      key — the wire shape and the runtime instance never diverge.
 *   4. **Codec round-trip identity.** For every registered tag with
 *      a defaultable construction shape, `serialize → deserialize`
 *      reconstructs an instance of the SAME class (not
 *      `UnknownAgentickError`) and `_tag` is preserved.
 *   5. **No orphan tags.** Every tag a producer can synthesize (via
 *      a known concrete class) is registered. Adopters wire their own
 *      tag-name list at the call site so the suite remains
 *      package-agnostic.
 *
 * The suite is parametrized over a `factory` that yields:
 *
 *   - `expectedTags` — the tag set the caller expects to be live
 *     (subset of the registry — registry may carry strictly more,
 *     e.g. `UnknownAgentickError`).
 *   - `instantiate(tag)` — caller-supplied stub-payload generator that
 *     returns a constructed instance of the class for `tag`. Lets the
 *     suite exercise round-trip without baking per-class arg shape
 *     knowledge into the suite itself.
 *
 * The intent is to be runnable against the whole framework registry
 * (`runAgentickErrorConformance({ ... })` in v2's own meta-suite) AND
 * against individual packages' subsets when adopters want to verify
 * just their own additions.
 */

import { describe, expect, it } from "vitest";
import {
  AgentickError,
  deserializeAgentickError,
  lookupAgentickError,
  serializeAgentickError,
  UnknownAgentickError,
  _registeredAgentickErrorTags,
} from "@agentick/spec";

export interface AgentickErrorConformanceFactory {
  /**
   * Tag-names the caller expects to be registered. The suite asserts
   * each is present in the registry. Tags NOT in this list are still
   * allowed in the registry (e.g. `UnknownAgentickError`, future
   * additions) — adopters call this with whatever subset they want
   * pinned.
   */
  readonly expectedTags: readonly string[];

  /**
   * Caller-supplied factory that constructs an instance of the class
   * registered under `tag`. The suite uses this to drive
   * codec round-trip checks without baking per-class arg shapes.
   * Return `null` to skip round-trip for a tag (e.g. opaque payloads
   * the caller doesn't have a stub for).
   */
  instantiate(tag: string): AgentickError | null;
}

export function runAgentickErrorConformance(factory: AgentickErrorConformanceFactory): void {
  describe("AgentickError — registry invariants", () => {
    it("every expected tag is registered", () => {
      const registered = new Set(_registeredAgentickErrorTags());
      const missing = factory.expectedTags.filter((tag) => !registered.has(tag));
      expect(missing).toEqual([]);
    });

    it("every registered tag resolves to a class constructor that subclasses AgentickError", () => {
      for (const tag of _registeredAgentickErrorTags()) {
        const Cls = lookupAgentickError(tag);
        expect(Cls).toBeDefined();
        // Subclass check via prototype chain. Concrete classes inherit
        // from AgentickError (possibly via a per-domain abstract
        // intermediate); prototype chain ascent reaches it either way.
        expect(Object.create(Cls!.prototype) instanceof AgentickError).toBe(true);
      }
    });
  });

  describe("AgentickError — instance shape", () => {
    for (const tag of factory.expectedTags) {
      it(`${tag}: caller-supplied instance is instanceof AgentickError + Error`, () => {
        const instance = factory.instantiate(tag);
        if (instance === null) return;
        expect(instance).toBeInstanceOf(AgentickError);
        expect(instance).toBeInstanceOf(Error);
        expect(instance._tag).toBe(tag);
        // `name` is set by AgentickError's base constructor to the
        // concrete subclass name — not "Error", not "AgentickError".
        expect(instance.name).not.toBe("Error");
        expect(instance.name).not.toBe("AgentickError");
      });
    }
  });

  describe("AgentickError — codec round-trip", () => {
    for (const tag of factory.expectedTags) {
      it(`${tag}: serialize → deserialize preserves class identity`, () => {
        const original = factory.instantiate(tag);
        if (original === null) return;
        const wire = serializeAgentickError(original);
        expect(wire._tag).toBe(tag);
        const restored = deserializeAgentickError(wire);
        // Must NOT fall through to UnknownAgentickError — that would
        // mean the registry doesn't carry `tag`.
        expect(restored).not.toBeInstanceOf(UnknownAgentickError);
        expect(restored._tag).toBe(tag);
        // Same concrete class as the original (prototype identity).
        expect(Object.getPrototypeOf(restored)).toBe(Object.getPrototypeOf(original));
      });

      it(`${tag}: survives JSON.stringify → JSON.parse → deserialize`, () => {
        const original = factory.instantiate(tag);
        if (original === null) return;
        const json = JSON.stringify(original);
        const restored = deserializeAgentickError(JSON.parse(json));
        expect(restored).not.toBeInstanceOf(UnknownAgentickError);
        expect(restored._tag).toBe(tag);
      });
    }
  });

  describe("AgentickError — unknown-tag fallback", () => {
    it("an unregistered tag deserializes to UnknownAgentickError that preserves the payload", () => {
      // Use a tag the registry definitely doesn't carry. Suffix with a
      // disambiguator so the test stays stable even if the suite is run
      // against a future registry that registers more tags.
      const fakeTag = "ConformanceFakeTag_" + factory.expectedTags.length;
      const restored = deserializeAgentickError({
        _tag: fakeTag,
        message: "from the future",
        someField: "preserved",
      });
      expect(restored).toBeInstanceOf(UnknownAgentickError);
      expect(restored).toBeInstanceOf(AgentickError);
      expect((restored as UnknownAgentickError).originalTag).toBe(fakeTag);
      expect((restored as UnknownAgentickError).payload).toEqual({
        _tag: fakeTag,
        message: "from the future",
        someField: "preserved",
      });
    });

    it("UnknownAgentickError re-serializes under the ORIGINAL tag (lossless forwarding)", () => {
      const fakeTag = "ConformanceFakeForwardTag_" + factory.expectedTags.length;
      const payload = { _tag: fakeTag, message: "carried", foo: 7 };
      const intermediate = deserializeAgentickError(payload);
      const reserialized = serializeAgentickError(intermediate);
      expect(reserialized._tag).toBe(fakeTag);
      expect(reserialized.foo).toBe(7);
    });
  });
}
