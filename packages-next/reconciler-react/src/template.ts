/**
 * `compileTemplate(element, opts)` and `renderTemplate(element, opts)`
 * — one-shot JSX → IR (compile) and JSX → string (render).
 *
 * The capability is "use the reconciler's compile-until-stable loop +
 * collect walker, but without spinning up a session / harness /
 * journal / operation wrap." For static-template use cases where
 * adopters want the IR (`compileTemplate`) or a fully-formatted string
 * (`renderTemplate`): prompt rendering, resource bodies, MCP server
 * prompts/resources, snapshot tests, doc generators.
 *
 * Two operations:
 *   - `compileTemplate(element, opts) → { tree, diagnostics, iterations }`
 *     Produces the `RenderedTree` IR + walker diagnostics.
 *   - `renderTemplate(element, opts) → { output, diagnostics, iterations }`
 *     Composes `compileTemplate` with `formatTree` from
 *     `@agentick/formatters-next` to produce the final string.
 *
 * Pipeline:
 *   1. Create a fresh container + react-reconciler instance
 *   2. Mount the element under minimal in-process bridges
 *      (`InMemoryDataBridge` for `useData`; trivial stubs for
 *      `loop` + `session`)
 *   3. Render → await pending data → render again until the
 *      DataBridge reports no pending fetches (or `maxIterations`
 *      / `awaitTimeoutMs` is exceeded)
 *   4. Run `collect()` against the stabilized host tree
 *   5. Unmount and return the IR (`compileTemplate`) — or pass
 *      it through `formatTree` for the string (`renderTemplate`)
 *
 * NOT for reactive workloads. Adopters wiring `<Tool>` (createTool
 * factory), knobs, signals, session state, or any harness-backed
 * concern should use the full `ReconcilerHarness` via `createApp`.
 * The bridges this function provides are minimal — knob/state/timeline
 * slots are absent, the session bridge reports a stub identity.
 *
 * @see docs/proposals/v2/STATUS.md — ADR 39 compiler-experiment post-mortem
 * @see packages-next/reconciler-react/src/harness/reconciler-harness.ts
 *      (the full harness that this strips down)
 */

import type { ReactNode } from "react";
import React from "react";
import {
  collect,
  createBuiltInRegistry,
  createContainer,
  createHostScope,
  InMemoryDataBridge,
  type ContributorRegistry,
} from "@agentick/reconciler-next";
import type {
  FormatterRef,
  HookBridges,
  LoopBridge,
  ReconcileDiagnostic,
  RenderedTree,
  SessionBridge,
} from "@agentick/spec-next";
import { RenderFailed } from "@agentick/spec-next";
import { type DefinedFormatter, formatTree, markdownFormatter } from "@agentick/formatters-next";
import { isThenable, omitUndefined } from "@agentick/utils-next";

import { BridgeContext } from "./react/bridge-context.js";
import { createReconciler } from "./react/reconciler.js";

// ============================================================================
// Public API
// ============================================================================

export interface CompileTemplateOptions {
  /**
   * Hard cap on compile-until-stable iterations. Default 10. Protects
   * against a `useData` that keeps re-throwing.
   */
  readonly maxIterations?: number;
  /**
   * Soft deadline for awaiting in-flight `useData` fetches between
   * iterations. When exceeded, the loop terminates and an
   * `await-timeout` warning is surfaced in `diagnostics`. Default:
   * no timeout (wait indefinitely).
   */
  readonly awaitTimeoutMs?: number;
  /**
   * Default formatter ref applied to the root scope. Section/message
   * entries that don't carry an in-scope `<format>` ancestor stamp
   * this ref onto `entry.renderedWith`. Default `{ id: "default" }`.
   */
  readonly defaultFormatter?: FormatterRef;
  /**
   * Override the default contributor registry. Useful when adopters
   * have registered framework-specific intrinsics. Default:
   * `createBuiltInRegistry()`.
   */
  readonly registry?: ContributorRegistry;
}

export interface CompileTemplateResult {
  readonly tree: RenderedTree;
  readonly diagnostics: readonly ReconcileDiagnostic[];
  /** Number of render passes the loop went through before stabilizing. */
  readonly iterations: number;
}

export interface RenderTemplateOptions extends CompileTemplateOptions {
  /**
   * Formatter for the IR → string serialization pass. Default
   * `markdownFormatter` from `@agentick/formatters-next`.
   */
  readonly formatter?: DefinedFormatter;
}

export interface RenderTemplateResult {
  readonly output: string;
  readonly diagnostics: readonly ReconcileDiagnostic[];
  readonly iterations: number;
}

/**
 * Compile a React element into a stable `RenderedTree` IR. Awaits
 * `useData` suspends to completion via the bundled `InMemoryDataBridge`.
 */
export async function compileTemplate(
  element: ReactNode,
  opts: CompileTemplateOptions = {},
): Promise<CompileTemplateResult> {
  return compileInternal(element, opts);
}

/**
 * Compile + serialize: produces a single formatted string from the IR.
 * Delegates serialization to `formatTree` in
 * `@agentick/formatters-next` — adding a formatter or extending
 * framing rules happens there, not here.
 */
export async function renderTemplate(
  element: ReactNode,
  opts: RenderTemplateOptions = {},
): Promise<RenderTemplateResult> {
  const compiled = await compileInternal(element, opts);
  const formatter = opts.formatter ?? markdownFormatter;
  const output = formatTree(compiled.tree, formatter);
  return {
    output,
    diagnostics: compiled.diagnostics,
    iterations: compiled.iterations,
  };
}

// ============================================================================
// Compile pipeline
// ============================================================================

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_FORMATTER_REF: FormatterRef = { id: "default" };

let mountCounter = 0;

async function compileInternal(
  element: ReactNode,
  opts: CompileTemplateOptions,
): Promise<CompileTemplateResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const mountId = `template#${(++mountCounter).toString(36)}`;
  const rootScope = createHostScope({
    formatter: opts.defaultFormatter ?? DEFAULT_FORMATTER_REF,
    path: [`mount:${mountId}`],
  });
  const container = createContainer({ mountId, rootScope });
  const registry = opts.registry ?? createBuiltInRegistry();

  const dataBridge = new InMemoryDataBridge();
  const bridges = {
    data: dataBridge,
    loop: stubLoopBridge(),
    session: stubSessionBridge(mountId),
  } as unknown as HookBridges;

  let renderError: unknown = null;
  const reconciler = createReconciler({
    container,
    idPrefix: mountId,
    onUncaughtError: (err) => {
      if (renderError === null) renderError = err;
    },
    onCaughtError: () => undefined,
    onRecoverableError: () => undefined,
  });
  const root = reconciler.createRoot();

  const diagnostics: ReconcileDiagnostic[] = [];
  let iterations = 0;
  let hitMax = false;

  try {
    for (iterations = 0; iterations < maxIterations; iterations++) {
      renderError = null;
      renderOnce(reconciler, root, bridges, element);

      const pending = dataBridge.pending();

      if (renderError !== null && pending.length === 0) {
        throw new RenderFailed({ cause: renderError });
      }
      if (pending.length === 0) break;

      const settled = Promise.allSettled(pending);
      if (opts.awaitTimeoutMs !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), opts.awaitTimeoutMs);
        });
        const outcome = await Promise.race([settled.then(() => "settled" as const), timeout]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcome === "timeout") {
          diagnostics.push({
            severity: "warning",
            code: "await-timeout",
            message: `compileTemplate: useData await exceeded ${opts.awaitTimeoutMs}ms; terminating with partial IR`,
          });
          break;
        }
      } else {
        await settled;
      }
    }

    if (iterations >= maxIterations) {
      hitMax = true;
      diagnostics.push({
        severity: "warning",
        code: "max-iterations",
        message: `compileTemplate: render-until-stable exceeded ${maxIterations} iterations`,
      });
    }

    const collected = collect({
      roots: container.children,
      registry,
      rootScope,
    });
    for (const d of collected.diagnostics) {
      diagnostics.push({
        severity: d.severity,
        code: d.code ?? "diagnostic",
        message: d.message,
        ...omitUndefined({ path: d.path, metadata: d.metadata }),
      });
    }

    return {
      tree: collected.tree,
      diagnostics,
      iterations: hitMax ? maxIterations : iterations + 1,
    };
  } finally {
    try {
      reconciler.render(null, root);
    } catch {
      // best-effort cleanup
    }
  }
}

function renderOnce(
  reconciler: ReturnType<typeof createReconciler>,
  root: ReturnType<ReturnType<typeof createReconciler>["createRoot"]>,
  bridges: HookBridges,
  element: ReactNode,
): void {
  const wrapped = React.createElement(BridgeContext.Provider, { value: bridges }, element);
  try {
    reconciler.render(wrapped, root);
  } catch (err) {
    if (!isThenable(err)) {
      throw err;
    }
  }
}

function stubLoopBridge(): LoopBridge {
  return {
    continueAfterTick: () => undefined,
    stopAfterTick: () => undefined,
  };
}

function stubSessionBridge(id: string): SessionBridge {
  return { id, status: "idle" };
}
