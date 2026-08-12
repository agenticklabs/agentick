/**
 * `secureExec()` — the in-process V8 isolate {@link Runtime}.
 *
 * The structural mirror of `hostRuntime()`: a session-blind {@link RuntimeProvider}
 * whose `capabilities()` is sync and engine-only, and whose `resolve()` ignores
 * the installer and builds a fresh isolate {@link Runtime} per session. The
 * difference is the trust mechanism — `hostRuntime` contains by CONFINEMENT (an
 * OS jail around a subprocess); this contains by CONSTRUCTION (an isolate with
 * nothing wired in), so it needs no jail primitive and adopts no sandbox.
 *
 * @see ./isolate-context.ts — one isolate + context per code context.
 */

import type {
  CodeRuntimeContext,
  CodeRuntimeContextOptions,
  Runtime,
  RuntimeProvider,
} from "@agentick/code";

import { isolateCapabilities, type SecureExecConfig } from "./capabilities.js";
import { IsolateContext } from "./isolate-context.js";
import { compiler } from "./language.js";

export function secureExec(config: SecureExecConfig = {}): RuntimeProvider {
  return {
    capabilities: () => isolateCapabilities(config),
    resolve: () => buildIsolateRuntime(config),
  };
}

function buildIsolateRuntime(config: SecureExecConfig): Runtime {
  const capabilities = isolateCapabilities(config);
  const compile = compiler(config.language ?? "javascript");
  const open = new Set<IsolateContext>();
  let disposed = false;

  return {
    capabilities,
    createContext: async (options: CodeRuntimeContextOptions): Promise<CodeRuntimeContext> => {
      if (disposed) throw new Error(`${capabilities.name}: the runtime is disposed`);
      const context = await IsolateContext.create(capabilities.name, compile, config, options);
      open.add(context);
      context.whenGone(() => open.delete(context));
      return context;
    },
    dispose: async (): Promise<void> => {
      disposed = true;
      await Promise.all([...open].map((context) => context.dispose()));
      open.clear();
    },
  };
}
