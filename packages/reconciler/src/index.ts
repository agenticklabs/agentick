/**
 * `@agentick/reconciler` — reconciler-agnostic base.
 *
 * Owns the callback-style `defineReconciler` factory and any
 * reconciler-flavored utilities that don't depend on a specific JSX
 * runtime. Concrete reconcilers — React (`@agentick/reconciler-react`),
 * Angular, Vue, custom DSLs — depend on this package.
 *
 * @see ../README.md
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 */

export { defineReconciler, type DefineReconcilerInput } from "./define-reconciler.js";
