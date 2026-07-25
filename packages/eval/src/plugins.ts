/**
 * The global eval-plugin registry — install-to-appear for the `t` context.
 *
 * A plugin package (or subpath) does two things on import: `declare module
 * "@agentick/eval"` to TYPE its `t` additions on {@link
 * EvalContextExtensions}, and call {@link registerEvalPlugin} to WIRE the
 * runtime factory. The runner composes every registered plugin (plus any
 * per-eval `plugins`) onto `t`. Same law as the server bridges / client
 * sub-handles (ADR 27): built-in vs optional is a packaging concern.
 *
 * Config-carrying plugins prefer the per-eval `plugins: [judge({ model })]`
 * form (no global config to thread); zero-config plugins (`sh`/`file` over a
 * conventional workspace) can register globally.
 */

import type { EvalPlugin } from "./types.js";

const registry: EvalPlugin[] = [];

/** Register a plugin globally — it composes onto `t` in every eval run. */
export function registerEvalPlugin(plugin: EvalPlugin): void {
  registry.push(plugin);
}

/** The globally-registered plugins, in registration order. */
export function registeredEvalPlugins(): readonly EvalPlugin[] {
  return registry;
}
