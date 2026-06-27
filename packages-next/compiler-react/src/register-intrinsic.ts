/**
 * `registerIntrinsic(tag, handler)` — runtime extension surface
 * (React-specific).
 *
 * Adopters add domain-specific intrinsics (`<recipe-card>`,
 * `<calendar-event>`, …) by registering a handler that produces a
 * `WalkResult`. The walker checks the registry BEFORE the built-in
 * switch, so registrations override built-ins (last-writer-wins).
 *
 * Module-level Map. Adopters typically call `registerIntrinsic` once
 * at module load; the returned unregister function is for tests +
 * the rare dynamic scenario.
 *
 * Per ADR 39 Phase 3: this replaces the retired `Contributor`
 * protocol from `reconciler-next/collect/contributors/`. Same
 * extension capability, dramatically smaller API surface.
 *
 * # Scope: this registry is React-specific
 *
 * Handlers receive `HostInstance[]` (React's post-commit tree shape)
 * and a React walker callback. A registration here does NOT carry
 * over to `compiler-angular-next` or `compiler-solid-next` — those
 * adapters have their own AST shapes and walkers.
 *
 * # The actual cross-framework extension story
 *
 * Most adopters who want a custom JSX tag should write a **function
 * component** that composes existing intrinsics:
 *
 *   const RecipeCard = ({ title }) => (
 *     <section id={`recipe:${title}`}>
 *       <h1>{title}</h1>
 *     </section>
 *   );
 *
 * This works in React, Angular, Solid — because the framework's
 * runtime evaluates the FC, and the intrinsics it produces (section,
 * h1) are framework-agnostic via the shared IR. NO registerIntrinsic
 * call needed.
 *
 * Use `registerIntrinsic` ONLY for:
 *  - NEW tag names that aren't composable from existing intrinsics
 *    (rare — the framework's vocabulary is reasonably complete)
 *  - Custom recursion semantics (e.g., a tag that walks children
 *    differently than the default walker — very rare)
 *  - Overriding a built-in for a domain-specific renderer (rare)
 *
 * TODO(adr-39-phase-3): A FUTURE cross-framework registry could live
 * in `compiler-next` for LEAF intrinsics (no children recursion —
 * pure `(props) => IRFragment`). Those would work in any framework
 * adapter. Defer until there's concrete demand from a plugin
 * package that needs cross-framework leaf-intrinsic registration.
 */

import type { HostInstance } from "@agentick/reconciler-next";

import type { WalkResult } from "./walk.js";

/**
 * Custom intrinsic handler. Receives the host element's props +
 * children (raw `HostInstance[]`, not pre-walked — handlers decide
 * whether and how to recurse via the `walk` callback) and returns
 * the IR fragment to merge into the parent's result.
 */
export type IntrinsicHandler = (
  props: Readonly<Record<string, unknown>>,
  children: readonly HostInstance[],
  walk: (children: readonly HostInstance[]) => WalkResult,
) => WalkResult;

const registry = new Map<string, IntrinsicHandler>();

/**
 * Register a handler for `tag`. Returns an unregister function.
 *
 * If `tag` is already registered (custom or built-in via the
 * fallback switch), the new handler takes precedence —
 * last-writer-wins on the registry, registry-wins over built-ins.
 *
 * Calling the returned unregister function removes ONLY this
 * specific registration. If multiple registrations exist for the
 * same tag, you get only the one you registered back; the registry
 * goes back to whatever it was before THIS call.
 */
export function registerIntrinsic(tag: string, handler: IntrinsicHandler): () => void {
  const previous = registry.get(tag);
  registry.set(tag, handler);
  return () => {
    // Only undo our own write — if someone else wrote OVER our handler
    // in the meantime, we leave their write alone.
    if (registry.get(tag) !== handler) return;
    if (previous === undefined) {
      registry.delete(tag);
    } else {
      registry.set(tag, previous);
    }
  };
}

/**
 * Look up a registered handler for `tag`. Returns `undefined` if no
 * custom registration exists; the walker falls through to the
 * built-in switch in that case.
 */
export function getRegisteredIntrinsic(tag: string): IntrinsicHandler | undefined {
  return registry.get(tag);
}

/**
 * Clear the entire registry. Intended for tests; do NOT call from
 * production code unless you really mean it.
 */
export function clearRegisteredIntrinsics(): void {
  registry.clear();
}
