/**
 * React-flavored `defineEval`. Identical to the base `defineEval`
 * except the `reconciler` slot defaults to `reactReconciler()`.
 *
 * Why a subpath: the base `@agentick/eval-next` is reconciler-agnostic
 * by design. Most adopters write React-shaped agents, so importing
 * from `@agentick/eval-next/react` removes the reconciler boilerplate.
 * Adopters using a non-React reconciler stay on the base export.
 *
 * This mirrors the `/react` subpath convention used by other harness
 * packages that add a React surface. The framework picks up
 * the dependency on `@agentick/reconciler-react-next` ONLY when the
 * `/react` subpath is imported.
 */

import { reactReconciler } from "@agentick/reconciler-react-next";

import { defineEval as defineEvalBase } from "../define-eval.js";
import type { CallableEval, EvalDefinition } from "../types.js";

/**
 * Same shape as the base `EvalDefinition`, but `reconciler` is
 * optional — when omitted, `reactReconciler()` stands in.
 */
export type ReactEvalDefinition<P = unknown> = Omit<EvalDefinition<P>, "reconciler"> & {
  readonly reconciler?: EvalDefinition<P>["reconciler"];
};

export function defineEval<P = unknown>(definition: ReactEvalDefinition<P>): CallableEval<P> {
  const reconciler = definition.reconciler ?? reactReconciler();
  return defineEvalBase<P>({ ...definition, reconciler });
}
