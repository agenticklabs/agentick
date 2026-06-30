/**
 * `runHarnessSlotConformance` — executable form of ADR 42's audit
 * checklist. Drives the runtime-testable rows of the slot-trichotomy
 * convention against any concrete harness slot.
 *
 * The 7-item checklist (from ADR 42 §Audit checklist):
 *
 *   1. Array shorthand   — `readonly Decl[]` collapses to a Config form
 *                          (this suite tests).
 *   2. Instance shorthand — pre-built instance collapses to `{ use }`
 *                          (this suite tests).
 *   3. `use:` escape hatch — Config form's instance field is named `use`
 *                          (this suite tests via the conflict cases).
 *   4. Public Instance type alias — STATIC; verified at compile time by
 *                          the caller using the alias in their types.
 *   5. Lifecycle ownership documented — STATIC; verified by README review.
 *   6. Read getter on parent — STATIC; verified at compile time.
 *   7. Test coverage for all three forms + rejection paths — THIS
 *                          SUITE provides the coverage.
 *
 * Rows 4/5/6 are static checks; this suite doesn't drive them. They
 * remain the adopter's responsibility per the checklist.
 *
 * @see docs/proposals/v2/blueprint/42-harness-slot-trichotomy.md
 */

import { describe, expect, it } from "vitest";

/**
 * Configuration for {@link runHarnessSlotConformance}.
 *
 * Generic parameters:
 *   - `Instance` — the public Instance type alias (e.g., `Skills`,
 *     `Prompts`, `Tools`). Pre-built harness shape.
 *   - `Decl` — the primary declaration type (e.g., `SkillsRegisterInput`,
 *     `PromptDeclaration`). Used in the array-shorthand form.
 *   - `Config` — the full options object literal type. Carries `use?`
 *     plus harness-specific fields (`initial`/`loaders`/etc.).
 */
export interface HarnessSlotConformanceOptions<Instance, Decl, Config extends object> {
  /**
   * Display name in test output. Typically the package + slot —
   * `"@agentick/skills-next withSkills"`, `"@agentick/prompts-next withPrompts"`.
   */
  readonly name: string;

  /**
   * The package's `resolveSlot` function. Accepts the union of the
   * three slot forms and returns the resolved Config shape (or throws
   * on invalid input).
   */
  readonly resolveSlot: (slot: readonly Decl[] | Instance | Config) => Config;

  /**
   * Build a Declaration for the array-shorthand test. Plain data — no
   * async setup, no lifecycle.
   */
  readonly makeDeclaration: () => Decl;

  /**
   * Build a fresh Instance for the instance-shorthand test. The suite
   * awaits the returned `close` after the test completes.
   */
  readonly makeInstance: () => Promise<{
    readonly instance: Instance;
    readonly close: () => void | Promise<void>;
  }>;

  /**
   * The Config field that array-shorthand collapses to. E.g., `"initial"`
   * for skills/prompts (sugar for `{ initial: [...] }`). The suite asserts
   * that `resolveSlot([decl])` returns `{ [shorthandKey]: [decl] }`.
   */
  readonly shorthandKey: keyof Config & string;

  /**
   * Optional: a `withX` extension factory. When provided, the suite
   * runs additional tests verifying the factory accepts each form.
   * Omit for slots that aren't backed by an extension (e.g., MCP
   * server slots that are config-only at the gateway level).
   */
  readonly factory?: (slot?: readonly Decl[] | Instance | Config) => unknown;

  /**
   * Optional: names of Config fields that conflict with `use:`. The
   * suite verifies each combination throws. E.g., for skills:
   * `["initial", "loaders"]`. Omit when the Config has no conflicts
   * (rare — usually at least one field conflicts with `use`).
   */
  readonly useConflicts?: readonly (keyof Config & string)[];

  /**
   * Required when `useConflicts` is provided. Sample values for each
   * conflicting field, used to construct the rejection-test inputs.
   * Keys must match `useConflicts` entries.
   */
  readonly useConflictSamples?: Readonly<Record<string, unknown>>;

  /**
   * Optional: pattern the rejection error message should match.
   * Defaults to `/use.*mutually exclusive/` (matches the standard
   * resolveSlot rejection message). Override for harnesses with
   * different phrasing.
   */
  readonly useConflictMessage?: RegExp;
}

/**
 * Drive the ADR 42 slot-trichotomy conformance suite against a
 * concrete harness slot.
 *
 * @example
 *     import { runHarnessSlotConformance } from "@agentick/spec-conformance-next";
 *     import { SkillsHarness } from "../harness.js";
 *     import { resolveSlot, withSkills } from "../extension.js";
 *
 *     runHarnessSlotConformance({
 *       name: "@agentick/skills-next withSkills",
 *       resolveSlot,
 *       factory: withSkills,
 *       makeDeclaration: () => ({ name: "x", description: "x", content: "x" }),
 *       makeInstance: async () => {
 *         const h = new SkillsHarness(...);
 *         await h.ready;
 *         return { instance: h, close: () => h.close() };
 *       },
 *       shorthandKey: "initial",
 *       useConflicts: ["initial", "loaders"],
 *       useConflictSamples: {
 *         initial: [{ name: "x", description: "x", content: "x" }],
 *         loaders: [/* a sample loader * /],
 *       },
 *     });
 */
export function runHarnessSlotConformance<Instance, Decl, Config extends object>(
  options: HarnessSlotConformanceOptions<Instance, Decl, Config>,
): void {
  const {
    name,
    resolveSlot,
    makeDeclaration,
    makeInstance,
    shorthandKey,
    factory,
    useConflicts,
    useConflictSamples,
    useConflictMessage = /use.*mutually exclusive/,
  } = options;

  describe(`${name} — ADR 42 slot trichotomy`, () => {
    // ── Row 1: array shorthand ─────────────────────────────────────

    describe("form A: array shorthand", () => {
      it(`collapses to { ${shorthandKey} }`, () => {
        const decl = makeDeclaration();
        const result = resolveSlot([decl]);
        expect(result).toEqual({ [shorthandKey]: [decl] });
      });
    });

    // ── Row 2: instance shorthand ──────────────────────────────────

    describe("form B: instance shorthand", () => {
      it("collapses to { use }", async () => {
        const { instance, close } = await makeInstance();
        try {
          const result = resolveSlot(instance);
          expect(result).toEqual({ use: instance });
        } finally {
          await close();
        }
      });
    });

    // ── Row 3 + 7: Config form + rejection paths ────────────────────
    //
    // Rejection cases use `it.runIf` to gate on the optional
    // `useConflicts` configuration WITHOUT introducing a conditional
    // `describe` (which lint disallows). Each conflict field becomes
    // a separate `it` that runs only when the caller supplied both
    // `useConflicts` and `useConflictSamples`.

    describe("form C: config object", () => {
      it(`passes through { ${shorthandKey} } unchanged`, () => {
        const decl = makeDeclaration();
        const cfg = { [shorthandKey]: [decl] } as unknown as Config;
        // Identity passthrough — same object reference returned.
        expect(resolveSlot(cfg)).toBe(cfg);
      });

      it("passes through { use } unchanged", async () => {
        const { instance, close } = await makeInstance();
        try {
          const cfg = { use: instance } as unknown as Config;
          expect(resolveSlot(cfg)).toBe(cfg);
        } finally {
          await close();
        }
      });

      const conflicts = useConflicts ?? [];
      const samples = useConflictSamples ?? {};
      for (const field of conflicts) {
        it.runIf(samples[field] !== undefined)(`rejects use: combined with ${field}:`, async () => {
          const { instance, close } = await makeInstance();
          try {
            const cfg = {
              use: instance,
              [field]: samples[field],
            } as unknown as Config;
            expect(() => resolveSlot(cfg)).toThrow(useConflictMessage);
          } finally {
            await close();
          }
        });
      }
    });

    // ── Factory shape (optional row from §"`withX` factory variant") ─
    //
    // Same lint constraint — replace conditional `describe(factory ? ...)` with
    // a sibling `describe` whose `it`s gate on `it.runIf(factory)`. Whole
    // suite is a no-op when `factory` is undefined.

    describe("withX factory accepts every form", () => {
      it.runIf(factory !== undefined)("accepts array shorthand", () => {
        const decl = makeDeclaration();
        expect(() => factory!([decl])).not.toThrow();
      });

      it.runIf(factory !== undefined)("accepts instance shorthand", async () => {
        const { instance, close } = await makeInstance();
        try {
          expect(() => factory!(instance)).not.toThrow();
        } finally {
          await close();
        }
      });

      it.runIf(factory !== undefined)(`accepts config { ${shorthandKey} }`, () => {
        const decl = makeDeclaration();
        const cfg = { [shorthandKey]: [decl] } as unknown as Config;
        expect(() => factory!(cfg)).not.toThrow();
      });

      it.runIf(factory !== undefined)("accepts no argument (empty default)", () => {
        expect(() => factory!()).not.toThrow();
      });
    });
  });
}
