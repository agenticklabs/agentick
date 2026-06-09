/**
 * React DevTools standalone bridge.
 *
 * Connects the reconciler to the standalone React DevTools application
 * (`npx react-devtools`, default port 8097). Each created reconciler
 * registers itself with the global DevTools hook via
 * `injectIntoDevTools` — no opt-in per reconciler is required, just
 * call `enableReactDevTools()` once at app startup before mounting.
 *
 * `react-devtools-core` is loaded via dynamic import — it is NOT a
 * declared peer dependency. Install it yourself in environments where
 * you want DevTools (`pnpm add -D react-devtools-core`). The bridge
 * gracefully no-ops (returning a `not-installed` outcome) when the
 * package isn't available — so production builds that don't bundle
 * it incur zero cost.
 *
 * @example
 * ```ts
 * import { enableReactDevTools, ReconcilerHarness } from "@agentick/reconciler-react-next";
 *
 * await enableReactDevTools();      // connect to localhost:8097
 * const harness = new ReconcilerHarness(...);
 * await harness.mount({ ... });     // visible in DevTools
 * ```
 */

export interface EnableReactDevToolsOptions {
  /** Default `"localhost"`. */
  readonly host?: string;
  /** Default `8097` — the standalone React DevTools default. */
  readonly port?: number;
  /**
   * Provide a pre-resolved `connectToDevTools` (from `react-devtools-core`).
   * Useful for tests; production callers leave this unset.
   */
  readonly connectToDevTools?: (options?: Record<string, unknown>) => void;
}

export type EnableReactDevToolsOutcome =
  | { readonly status: "connected"; readonly host: string; readonly port: number }
  | { readonly status: "already-connected" }
  | { readonly status: "not-installed" }
  | { readonly status: "failed"; readonly error: unknown };

/** Module-local state. One global connection per process. */
let connected = false;

/**
 * Connect this process to the standalone React DevTools application.
 * Idempotent — subsequent calls return `already-connected`.
 *
 * Returns an outcome rather than throwing: production-only code paths
 * (where DevTools isn't installed) get a typed "not installed" signal
 * instead of a console warning + side-effecting state.
 */
export async function enableReactDevTools(
  options: EnableReactDevToolsOptions = {},
): Promise<EnableReactDevToolsOutcome> {
  if (connected) return { status: "already-connected" };

  const host = options.host ?? "localhost";
  const port = options.port ?? 8097;

  let connectFn = options.connectToDevTools;
  if (!connectFn) {
    try {
      // `react-devtools-core` is an optional runtime dependency — install
      // it locally to enable DevTools. Suppress the missing-module error.
      // @ts-ignore optional runtime dependency
      const mod = (await import(/* @vite-ignore */ "react-devtools-core")) as {
        connectToDevTools?: (options?: Record<string, unknown>) => void;
        default?: { connectToDevTools?: (options?: Record<string, unknown>) => void };
      };
      connectFn = mod.connectToDevTools ?? mod.default?.connectToDevTools;
    } catch {
      return { status: "not-installed" };
    }
  }

  if (!connectFn) return { status: "not-installed" };

  try {
    connectFn({
      host,
      port,
      resolveRNStyle: null,
      isAppActive: () => true,
    });
    connected = true;
    return { status: "connected", host, port };
  } catch (error) {
    return { status: "failed", error };
  }
}

/** Query connection state. */
export function isReactDevToolsConnected(): boolean {
  return connected;
}

/**
 * Mark the bridge as disconnected. `react-devtools-core` itself does
 * not expose a clean disconnect — this only resets our state flag so
 * a subsequent `enableReactDevTools()` retries the connection. The
 * underlying WebSocket may remain open until the process exits.
 */
export function disableReactDevTools(): void {
  connected = false;
}
