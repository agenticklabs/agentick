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

/** A registered slot: its name plus (for extension-installed namespaces) its installer. */
interface NamespaceSlot {
  readonly name: string;
  readonly toExtension?: NamespaceSlotToExtension;
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
  options?: { readonly toExtension?: NamespaceSlotToExtension },
): void {
  const existing = slots.get(name);
  if (existing !== undefined) {
    // Idempotent on the NAME, but a later registration may supply the installer
    // arm a bare earlier one lacked (e.g. `augment.ts` imported before the
    // extension module finished evaluating). Never downgrade an existing arm.
    if (options?.toExtension !== undefined && existing.toExtension === undefined) {
      slots.set(name, { name, toExtension: options.toExtension });
    }
    return;
  }
  slots.set(
    name,
    options?.toExtension !== undefined ? { name, toExtension: options.toExtension } : { name },
  );
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
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const name of slots.keys()) {
    const value = options[name];
    if (value !== undefined) out[name] = value;
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
