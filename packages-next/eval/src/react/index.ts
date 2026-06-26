/**
 * `@agentick/eval-next/react` — React-flavored eval factory.
 *
 * Same surface as the base `@agentick/eval-next` export, with one
 * convenience: `reconciler` defaults to `reactReconciler()` when not
 * supplied. Adopters running JSX agents skip the reconciler boilerplate.
 *
 * Use the base export (`@agentick/eval-next`) when running a different
 * reconciler (Angular, custom AST, etc.). The base eval framework is
 * reconciler-agnostic; this subpath is sugar.
 */

export { defineEval } from "./define-eval.js";
export type { ReactEvalDefinition } from "./define-eval.js";
