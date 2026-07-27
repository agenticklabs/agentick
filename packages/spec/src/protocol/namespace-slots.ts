/**
 * Namespace config slots (ADR 93 §"Top-level slots for every namespace") — the
 * TYPE half of the top-level-slots law. `NamespaceSlots` is an EMPTY SEED, the
 * exact sibling of {@link import("./hook-bridges.js").HookBridges}: every
 * namespace package — built-in or optional — adds its own slot via TypeScript
 * module augmentation, and the app-config interface simply extends the seed.
 *
 * ```ts
 * // @agentick/timeline/src/augment.ts
 * declare module "@agentick/spec" {
 *   interface NamespaceSlots {
 *     readonly timeline?: TimelineDefinition | TimelineHarnessProtocol;
 *   }
 * }
 * registerNamespaceSlot("timeline"); // the runtime half
 * ```
 *
 * Spec hardcodes NOTHING here — there is no `timeline?:` line in this file, and
 * none in `@agentick/app` either. That is the whole point (ADR 27): built-ins
 * are bundled, not privileged. The metapackage bundles the built-ins so their
 * slots are always lit; an optional package's slot lights up on install +
 * import. `extensions: []` remains the fully-dynamic escape hatch for
 * runtime-built arrays, conditional composition, and slot-less third parties.
 *
 * Every slot obeys the same laws (ADR 93):
 *   - it accepts a `defineX(...)` **definition** OR a **live instance** (the
 *     ADR-42 dichotomy — no third form);
 *   - it carries the `hooks:` / `guards:` bags;
 *   - store-bearing namespaces carry the genesis seam (`hydrate`), environment
 *     namespaces carry `bootstrap`.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 */

/**
 * The augmentation seed for top-level namespace config slots. Empty by design —
 * see the module doc. `AppHarnessOptions` extends this, so a namespace package's
 * augmentation lands on `createApp({ … })` with no change to `@agentick/app`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NamespaceSlots {}
