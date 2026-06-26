/**
 * `compileToTree(element, opts?)` — async entry point for the React
 * static-template compiler.
 *
 * Lifecycle per call:
 *   1. Wrap in a fresh `RenderContext` (compiler-next's stack-discipline
 *      ambient state for `useData`).
 *   2. Construct a fresh react-reconciler instance + container.
 *   3. Mount the element. react-reconciler evaluates function
 *      components, sets up its dispatcher (so React Context / refs /
 *      memoization / etc. work correctly), and commits a `HostInstance`
 *      tree via our host config.
 *   4. If any `useData` suspended (thrown Promises in RenderContext),
 *      await them and re-render. Repeat until stable.
 *   5. Walk the committed `HostInstance` tree → `RenderedTree` IR via
 *      the shared post-commit dispatch.
 *   6. Unmount and return the IR.
 *
 * Returns `RenderedTree` (the canonical IR). Callers wanting a string
 * compose with `format()` from `@agentick/compiler-next` (the `render()`
 * entry point in this package does that for you).
 *
 * NOT a harness. Pure async function.
 */

import { createRenderContext, isThenable } from "@agentick/compiler-next";
import { createContainer, type ReconcilerContainer } from "@agentick/reconciler-next";
import type { RenderedTree } from "@agentick/spec-next";
import { createElement, type ReactNode } from "react";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import ReactReconciler from "react-reconciler";

import { createHostConfig } from "./host-config.js";
import { RenderContextProvider } from "./use-data.js";
import { walkChildren } from "./walk.js";

export interface CompileToTreeOptions {
  /**
   * Hard cap on compile-until-stable iterations. Default 50. Protects
   * against a `useData` that keeps re-throwing.
   */
  readonly maxIterations?: number;
  /** Spec version stamped on the resulting `RenderedTree`. */
  readonly specVersion?: string;
}

const DEFAULT_SPEC_VERSION = "2026-05-08";
const DEFAULT_MAX_ITERATIONS = 50;

let mountCounter = 0;

export async function compileToTree(
  element: ReactNode,
  opts: CompileToTreeOptions = {},
): Promise<RenderedTree> {
  const ctx = createRenderContext();
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const specVersion = opts.specVersion ?? DEFAULT_SPEC_VERSION;

  const mountId = `compiler-react#${(++mountCounter).toString(36)}`;
  const idPrefix = mountId;
  const container = createContainer({ mountId });
  const hostConfig = createHostConfig({ container, idPrefix });
  let renderError: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reconciler = (ReactReconciler as unknown as (cfg: any) => any)(hostConfig) as {
    readonly createContainer: (...args: unknown[]) => unknown;
    readonly updateContainerSync?: (
      el: ReactNode,
      r: unknown,
      parent?: unknown,
      cb?: () => void,
    ) => void;
    readonly updateContainer: (
      el: ReactNode | null,
      r: unknown,
      parent?: unknown,
      cb?: () => void,
    ) => void;
    readonly flushSyncWork?: () => void;
  };
  const root = reconciler.createContainer(
    container,
    0, // LegacyRoot — sync render mode
    null,
    false,
    null,
    mountId,
    (err: unknown) => {
      if (renderError === undefined) renderError = err;
    },
    () => undefined,
    () => undefined,
    null,
  );

  // Wrap once — the RenderContext threads through React's own state
  // machine (Context propagation survives react-reconciler's async
  // suspense retries; stack-discipline would not).
  const wrapped = createElement(RenderContextProvider, { value: ctx }, element);

  try {
    for (let i = 0; i < maxIterations; i++) {
      const caught = renderOnce(reconciler, root, wrapped);
      // Errors from useData / component throws — react-reconciler may
      // surface them via onUncaughtError (captured into renderError)
      // OR via the synchronous-throw path (captured into caught).
      const renderErr = caught ?? renderError;
      renderError = undefined; // reset for the next pass
      if (renderErr !== undefined && !isThenable(renderErr)) {
        throw renderErr;
      }
      const pending = Array.from(ctx.pending.values());
      if (pending.length === 0 && renderErr === undefined) {
        // Stable. Walk the committed tree.
        return finalize(container, specVersion);
      }
      // Await all pending. useData propagates the underlying fetcher
      // rejection; Promise.all surfaces the first error directly.
      await Promise.all(pending);
    }
    throw new Error(
      `compileToTree: exceeded ${maxIterations} iterations without stabilizing. ` +
        `Likely cause: a useData fetcher keeps rejecting fresh, or a custom suspend ` +
        `mechanism never resolves. Pass { maxIterations } to extend the cap.`,
    );
  } finally {
    // Unmount — clear the container's tree.
    if (reconciler.updateContainerSync) {
      reconciler.updateContainerSync(null, root, null, () => undefined);
      reconciler.flushSyncWork?.();
    } else {
      reconciler.updateContainer(null, root, null, () => undefined);
    }
  }
}

// ────────── Internals ──────────

function renderOnce(
  reconciler: {
    readonly updateContainerSync?: (
      el: ReactNode,
      r: unknown,
      parent?: unknown,
      cb?: () => void,
    ) => void;
    readonly updateContainer: (
      el: ReactNode | null,
      r: unknown,
      parent?: unknown,
      cb?: () => void,
    ) => void;
    readonly flushSyncWork?: () => void;
  },
  root: unknown,
  element: ReactNode,
): unknown | undefined {
  try {
    // LegacyRoot mode: updateContainerSync queues a synchronous
    // update; flushSyncWork drains it. Function components evaluate
    // INSIDE react-reconciler's dispatcher; useData reads the
    // RenderContext via React Context (set by the Provider wrap),
    // so it survives react-reconciler's async retries.
    if (reconciler.updateContainerSync) {
      reconciler.updateContainerSync(element, root, null, () => undefined);
      reconciler.flushSyncWork?.();
    } else {
      reconciler.updateContainer(element, root, null, () => undefined);
    }
    return undefined;
  } catch (err) {
    return err;
  }
}

function finalize(container: ReconcilerContainer, specVersion: string): RenderedTree {
  const walked = walkChildren(container.children);
  return {
    specVersion,
    context: { entries: walked.entries },
    ...(walked.blocks.length > 0 ? { content: walked.blocks } : {}),
  };
}
