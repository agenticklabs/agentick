/**
 * `compileToTree(element, opts)` — the async entry point for the
 * React static-template compiler.
 *
 * Per ADR 39: compile-until-stable. The walker is synchronous; if a
 * `useData` suspends (throws a Promise), the loop catches, awaits,
 * retries. Each retry runs in the SAME `RenderContext` so the cache
 * stays populated; the suspend-then-resolve pattern is what unblocks
 * the next walk.
 *
 * Returns `RenderedTree` — the IR. Callers wanting a string compose
 * with `format()` from `@agentick/compiler-next` (the `render` entry
 * point in this package does that for you).
 *
 * The compiler is a pure async function. NOT a harness — no
 * `runOperation`, no events, no middleware. Adopters who want
 * observability wrap with their own instrumentation.
 */

import {
  createRenderContext,
  isThenable,
  withRenderContext,
  type RenderContext,
} from "@agentick/compiler-next";
import type { RenderedTree } from "@agentick/spec-next";
import type { ReactNode } from "react";

import { walk, type WalkResult } from "./walk.js";

export interface CompileToTreeOptions {
  /**
   * Hard cap on compile-until-stable iterations. Defaults to 50.
   * Protects against runaway loops if a `useData` keeps re-throwing.
   */
  readonly maxIterations?: number;
  /**
   * Spec version stamped on the resulting `RenderedTree`. Defaults to
   * the framework's current spec version.
   */
  readonly specVersion?: string;
}

const DEFAULT_SPEC_VERSION = "2026-05-08";
const DEFAULT_MAX_ITERATIONS = 50;

/**
 * Compile a React element to `RenderedTree`. Async — `useData` may
 * suspend at any depth, so the call site MUST `await`.
 *
 * The element is typically `<Template {...props} />` produced by the
 * caller. compileToTree doesn't do JSX-creation itself; adopters
 * either pass the element directly or use `render(Template, props)`
 * which constructs it.
 */
export async function compileToTree(
  element: ReactNode,
  opts: CompileToTreeOptions = {},
): Promise<RenderedTree> {
  const ctx = createRenderContext();
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const specVersion = opts.specVersion ?? DEFAULT_SPEC_VERSION;

  for (let i = 0; i < maxIterations; i++) {
    const outcome = walkOnce(ctx, element);
    if (outcome.kind === "stable") {
      return finalize(outcome.result, specVersion);
    }
    if (outcome.kind === "suspended") {
      // Swallow rejection — useData caches its own rejection as a
      // CachedRejection sentinel, so the next pass surfaces the error
      // synchronously (not via the await). See compiler-next/use-data.ts.
      await outcome.pending.then(
        () => undefined,
        () => undefined,
      );
      continue;
    }
    // outcome.kind === "error"
    throw outcome.error;
  }

  throw new Error(
    `compileToTree: exceeded ${maxIterations} iterations without stabilizing. ` +
      `Likely cause: a useData fetcher keeps rejecting fresh, or a suspend ` +
      `mechanism never resolves. Pass { maxIterations } to extend the cap.`,
  );
}

// ────────── Internals ──────────

type WalkOutcome =
  | { readonly kind: "stable"; readonly result: WalkResult }
  | { readonly kind: "suspended"; readonly pending: PromiseLike<unknown> }
  | { readonly kind: "error"; readonly error: unknown };

function walkOnce(ctx: RenderContext, element: ReactNode): WalkOutcome {
  let result: WalkResult | undefined;
  let suspended: PromiseLike<unknown> | undefined;
  let error: unknown;

  withRenderContext(ctx, () => {
    try {
      result = walk(element);
    } catch (err) {
      if (isThenable(err)) suspended = err;
      else error = err;
    }
  });

  if (result) return { kind: "stable", result };
  if (suspended) return { kind: "suspended", pending: suspended };
  return { kind: "error", error };
}

function finalize(result: WalkResult, specVersion: string): RenderedTree {
  return {
    specVersion,
    context: { entries: result.entries },
    ...(result.blocks.length > 0 ? { content: result.blocks } : {}),
  };
}
