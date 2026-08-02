/**
 * `compileTemplate(element, opts)` and `renderTemplate(element, opts)`
 * — one-shot JSX → IR (compile) and JSX → string (render).
 *
 * The capability is "use the compiler's compile-until-stable loop +
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
 *     `@agentick/formatters` to produce the final string.
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
 *   5. Run the formatter pass over every entry — semantic sidecars
 *      resolved, sections lowered into the entry's dialect — so the IR
 *      that comes back is wire-shape, the same contract
 *      `CompilerHarness.renderTree` returns
 *   6. Unmount and return the IR (`compileTemplate`) — or pass
 *      it through `formatTree` for the string (`renderTemplate`)
 *
 * NOT for reactive workloads. Adopters wiring `<Tool>` (createTool
 * factory), knobs, signals, session state, or any harness-backed
 * concern should use the full `CompilerHarness` via `createApp`.
 * The bridges this function provides are minimal — knob/state/timeline
 * slots are absent, the session bridge reports a stub identity.
 *
 * @see docs/proposals/v2/STATUS.md — ADR 39 compiler-experiment post-mortem
 * @see packages/compiler-react/src/harness/compiler-harness.ts
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
} from "@agentick/compiler";
import type {
  FormatterRef,
  HookBridges,
  LoopBridge,
  ReconcileDiagnostic,
  RenderedTree,
  SessionBridge,
} from "@agentick/spec";
import { RenderFailed } from "@agentick/spec";
import {
  builtInFormatters,
  formatTree,
  markdownFormatter,
  resolveFormatterRef,
  type DefinedFormatter,
} from "@agentick/formatters";
import { isThenable, omitUndefined } from "@agentick/utils";

import { BridgeContext } from "./react/bridge-context.js";
import { createCompiler } from "./react/compiler.js";

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
  /**
   * Wire-shape IR: entry content has been through the formatter pass, so no
   * semantic-node or section-node sidecar survives on it. Consumers that ship
   * this straight to a wire — `@agentick/prompts-react`, and through it MCP
   * `prompts/get` — get lowered text, not structure.
   */
  readonly tree: RenderedTree;
  readonly diagnostics: readonly ReconcileDiagnostic[];
  /** Number of render passes the loop went through before stabilizing. */
  readonly iterations: number;
}

export interface RenderTemplateOptions extends CompileTemplateOptions {
  /**
   * Formatter for the IR → string serialization pass. Default
   * `markdownFormatter` from `@agentick/formatters`.
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
 * `@agentick/formatters` — adding a formatter or extending
 * framing rules happens there, not here.
 */
export async function renderTemplate(
  element: ReactNode,
  opts: RenderTemplateOptions = {},
): Promise<RenderTemplateResult> {
  // The caller asked for ONE dialect for the whole output, and a dialect now
  // decides how a section reads — so it has to be in force during the block
  // pass, not applied afterwards to blocks another dialect already lowered.
  const formatter = opts.formatter ?? markdownFormatter;
  const compiled = await compileInternal(element, opts, formatter);
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
  pinned?: DefinedFormatter,
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
  const compiler = createCompiler({
    container,
    idPrefix: mountId,
    onUncaughtError: (err) => {
      if (renderError === null) renderError = err;
    },
    onCaughtError: () => undefined,
    onRecoverableError: () => undefined,
  });
  const root = compiler.createRoot();

  const diagnostics: ReconcileDiagnostic[] = [];
  let iterations = 0;
  let hitMax = false;

  try {
    for (iterations = 0; iterations < maxIterations; iterations++) {
      renderError = null;
      renderOnce(compiler, root, bridges, element);

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
      tree: applyFormatters(collected.tree, rootScope.formatters.default, pinned),
      diagnostics,
      iterations: hitMax ? maxIterations : iterations + 1,
    };
  } finally {
    try {
      compiler.render(null, root);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * The formatter pass, standalone: replace each entry's content with the
 * formatter-flattened version, resolving per-entry `renderedWith` against the
 * built-in registry. `pinned` forces one formatter over every entry.
 *
 * The same pass `CompilerHarness.renderTree` runs — deliberately, because the
 * two are the only ways to get a `RenderedTree` out of JSX and an adopter
 * should not have to know which one produced theirs. Unlike the harness's
 * copy this one is silent about an unresolvable ref: `compileTemplate` has no
 * formatter registry to configure, so a miss is the caller's `defaultFormatter`
 * naming something the built-ins do not carry, and markdown is the documented
 * answer to that rather than a warning.
 */
function applyFormatters(
  tree: RenderedTree,
  fallback: FormatterRef,
  pinned: DefinedFormatter | undefined,
): RenderedTree {
  const registry = builtInFormatters();
  const resolve = (ref: FormatterRef): DefinedFormatter =>
    pinned ?? resolveFormatterRef(registry, ref, markdownFormatter).formatter;

  const entries = tree.context.entries.map((entry) => ({
    ...entry,
    content: resolve(entry.renderedWith ?? fallback)(entry.content),
  }));
  const content =
    tree.content && tree.content.length > 0
      ? resolve(tree.renderedWith ?? fallback)(tree.content)
      : tree.content;
  return {
    ...tree,
    context: { ...tree.context, entries },
    ...omitUndefined({ content }),
  };
}

function renderOnce(
  compiler: ReturnType<typeof createCompiler>,
  root: ReturnType<ReturnType<typeof createCompiler>["createRoot"]>,
  bridges: HookBridges,
  element: ReactNode,
): void {
  const wrapped = React.createElement(BridgeContext.Provider, { value: bridges }, element);
  try {
    compiler.render(wrapped, root);
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
