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

/** Registered top-level namespace-config slot names, in registration order. */
const slots = new Set<string>();

// TODO(adr-93 D3/D4): today a slot is a NAME only, and the layer that owns the
// namespace pulls its value out (session-bridges reads `"timeline"` because it
// constructs the timeline eagerly for the session's required bridge set). The
// namespaces converting next — skills, prompts, tasks, sandbox — are
// EXTENSION-installed, so their slots need the second arm: a
// `toExtension(value) => AppExtension | SessionExtension` alongside the name, so
// the app can turn a slot value into an install with no per-namespace code. Not
// built here because a single consumer cannot pin the shape (three-consumers
// rule) — add it WITH the first extension-installed conversion.

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
 */
export function registerNamespaceSlot(name: string): void {
  slots.add(name);
}

/**
 * The currently-registered namespace slot names. Read by the app to project the
 * top-level slots out of its options bag; also the introspection hook a test
 * uses to assert a package lit its slot on import.
 */
export function registeredNamespaceSlots(): readonly string[] {
  return [...slots];
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
  for (const name of slots) {
    const value = options[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
