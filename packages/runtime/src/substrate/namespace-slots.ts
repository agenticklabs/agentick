/**
 * Namespace config slots (ADR 93 §"Top-level slots for every namespace") — the
 * RUNTIME half of the top-level-slots law. The TYPE half is module augmentation
 * of `NamespaceSlots` in `@agentick/spec`; this is the side-effect registration
 * that tells the app WHICH top-level config keys are namespace definitions, so
 * the app can forward them without naming a single namespace.
 *
 * ## Why a registry and not a hardcoded list
 *
 * ADR 27 forbids code-level privilege: `createApp({ timeline })` must not exist
 * because `@agentick/app` wrote `timeline?:` into its options interface. It
 * exists because `@agentick/timeline` — a package the app never imports —
 * augments the spec seed for the type and calls {@link registerNamespaceSlot}
 * for the runtime. The metapackage bundles the built-ins so their slots are
 * always lit; an optional package's slot lights up on install + import.
 * `extensions: []` survives as the fully-dynamic escape hatch.
 *
 * Exactly the mechanism `registerSessionHandleExtension` (`@agentick/client-core`)
 * already uses for client sub-handles: a module-level `Set` populated by
 * side-effect imports, read once by the assembling layer.
 *
 * @see docs/proposals/v2/blueprint/93-namespace-definitions.md
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @verifiedBy packages/runtime/src/__tests__/namespace-slots.spec.ts
 */

import { omitUndefined } from "@agentick/utils";

/**
 * Turn a slot VALUE into the extension that installs it (ADR 93) — the second
 * arm of a slot registration, supplied by EXTENSION-INSTALLED namespaces.
 *
 * Two shapes of namespace, one slot registry:
 *
 *   - **Host-constructed** (timeline, elicitation, tasks, resources): the
 *     session builds the harness itself for its required bridge set, so the slot
 *     needs a NAME only — the owning layer reads the value under that key. These
 *     register with no `toExtension`.
 *   - **Extension-installed** (skills, prompts, sandbox, mcp): there is no
 *     construction site until an extension runs, so the slot must be able to
 *     MINT that install. `toExtension` is exactly the package's own `withX(…)`
 *     factory, which already accepts the definition | inline | live-instance
 *     dichotomy.
 *
 * The value is `unknown` because the app never inspects a definition's shape —
 * the owning package's factory does the narrowing.
 */
export type NamespaceSlotToExtension = (value: unknown) => unknown;

/**
 * Build a namespace's APP-SCOPED defaults — the third arm of a slot
 * registration, supplied by namespaces whose defaults must OUTLIVE one session.
 *
 * Called ONCE per app; the returned fold runs per session, merging those
 * defaults UNDER that session's slot value (adopter wins). A store-backed
 * namespace defaulting to a per-harness store cannot survive an evict/resume
 * cycle at all — the checkpoint contract carries no value across the seam, so
 * `hydrate` reads a store the evicted harness took with it. The app-scoped
 * default is what makes the one recovery path work zero-config.
 *
 * The fold — rather than a plain defaults bag the app merges itself — is what
 * lets a slot that accepts a LIVE HARNESS as well as a definition (the ADR 42
 * dichotomy) pass the instance through untouched.
 *
 * @see docs/proposals/v2/checkpointing.md §4
 */
export type NamespaceSlotAppScope = () => (slotValue: unknown) => unknown;

/** A registered slot: its name plus the optional installer / app-scope arms. */
interface NamespaceSlot {
  readonly name: string;
  readonly toExtension?: NamespaceSlotToExtension;
  readonly appScope?: NamespaceSlotAppScope;
}

/** Registered top-level namespace-config slots, keyed by name, in registration order. */
const slots = new Map<string, NamespaceSlot>();

/**
 * Register a top-level config slot for a namespace (ADR 93). Called as a
 * side-effect from the owning harness package's `augment.ts`, alongside the
 * `declare module "@agentick/spec" { interface NamespaceSlots { … } }` that
 * types it. Idempotent — a repeat registration of the same name is a no-op, so
 * a package imported twice (or a test importing both the package and its
 * `/testing` subpath) never double-registers.
 *
 * The name MUST equal the key the augmentation added to `NamespaceSlots` and
 * the namespace's bridge slot name (`"timeline"`), because the app forwards the
 * value under that key and the consuming layer reads it under that key.
 *
 * An EXTENSION-INSTALLED namespace passes `options.toExtension` — its `withX(…)`
 * factory — so the app can turn the slot value into an install without naming
 * the namespace. See {@link NamespaceSlotToExtension}.
 */
export function registerNamespaceSlot(
  name: string,
  options?: {
    readonly toExtension?: NamespaceSlotToExtension;
    readonly appScope?: NamespaceSlotAppScope;
  },
): void {
  const existing = slots.get(name);
  // Idempotent on the NAME, but a later registration may supply an arm a bare
  // earlier one lacked (e.g. `augment.ts` imported before the extension module
  // finished evaluating). Never downgrade an existing arm.
  slots.set(name, {
    name,
    ...omitUndefined({
      toExtension: options?.toExtension ?? existing?.toExtension,
      appScope: options?.appScope ?? existing?.appScope,
    }),
  });
}

/**
 * The currently-registered namespace slot names. Read by the app to project the
 * top-level slots out of its options bag; also the introspection hook a test
 * uses to assert a package lit its slot on import.
 */
export function registeredNamespaceSlots(): readonly string[] {
  return [...slots.keys()];
}

/**
 * Project the registered namespace slots out of a config bag (ADR 93) — the
 * app's forwarding step. Returns only the slots actually present (an omitted
 * slot stays absent so the consuming layer's own default applies), keyed by
 * slot name and carried as `unknown`: the app never inspects a definition's
 * shape, it only routes it to the layer that owns that namespace.
 */
export function collectNamespaceSlots(
  options: Readonly<Record<string, unknown>>,
  appScopes: Readonly<Record<string, (slotValue: unknown) => unknown>> = {},
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const name of slots.keys()) {
    const value = options[name];
    const fold = appScopes[name];
    if (fold !== undefined) out[name] = fold(value);
    else if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Build every registered namespace's app-scoped defaults — called ONCE per app,
 * at construction. The returned folds are handed back to
 * {@link collectNamespaceSlots} for each session the app builds, so one store
 * per namespace serves every session it creates.
 *
 * @see NamespaceSlotAppScope
 */
export function namespaceSlotAppScopes(): Readonly<
  Record<string, (slotValue: unknown) => unknown>
> {
  const out: Record<string, (slotValue: unknown) => unknown> = {};
  for (const slot of slots.values()) {
    if (slot.appScope !== undefined) out[slot.name] = slot.appScope();
  }
  return out;
}

/**
 * Mint the extension installs for the EXTENSION-INSTALLED namespace slots
 * present in a config bag (ADR 93) — the app's second forwarding step, the twin
 * of {@link collectNamespaceSlots}.
 *
 * `createApp({ skills: defineSkills({…}) })` must end up doing what
 * `createApp({ extensions: [withSkills(defineSkills({…}))] })` does, WITHOUT
 * `@agentick/app` importing `@agentick/skills`. This walks the slot registry,
 * and for each slot that both (a) is present in `options` and (b) registered a
 * `toExtension` arm, calls that arm to get the install. Slots with no
 * `toExtension` are host-constructed and are skipped — the owning layer reads
 * them out of {@link collectNamespaceSlots} instead.
 *
 * Returned in registration order. The app SUPPRESSES a minted install when an
 * adopter extension in `extensions: []` carries the same extension name — the
 * escape hatch outranks the sugar. Suppression is the mechanism (not install
 * ordering): a namespace install registers an inbox address, and a second
 * install for the same namespace is a loud address collision by design.
 *
 * Typed `unknown[]` because spec's `Extension` union is not visible from this
 * file's dependency direction; the caller narrows.
 */
// Called by the app's extension partition (`packages/app/src/harness.ts`),
// which spreads the minted installs BEFORE the adopter's `extensions: []` so
// an explicit `withX(...)` there still overrides the slot (namespace
// registration is last-writer-wins — the escape hatch outranks the sugar).
export function namespaceSlotExtensions(
  options: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  const out: unknown[] = [];
  for (const slot of slots.values()) {
    if (slot.toExtension === undefined) continue;
    const value = options[slot.name];
    if (value === undefined) continue;
    out.push(slot.toExtension(value));
  }
  return out;
}
