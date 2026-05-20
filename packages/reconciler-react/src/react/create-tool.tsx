/**
 * React-flavored `createTool` — extends the generic factory from
 * `@agentick/tool` with a render-time `use()` slot.
 *
 * Why this layer exists: tools authored inside a JSX tree often need
 * access to tree-scoped values — a sandbox handle from `<Sandbox>`, an
 * MCP server from `<MCP>`, anything reachable through React Context.
 * React's rules forbid calling hooks outside render; the harness's
 * dispatch flow runs handlers far outside any component. The bridge:
 *
 *   1. The `Tool` component renders inside the agent's JSX tree.
 *   2. On every render it calls `spec.use()` (which may call hooks)
 *      and stores the result in a closed-over ref.
 *   3. The handler closure reads `useRef.current` when invoked, so the
 *      handler "sees" whatever the most recent render captured.
 *   4. The component registers the handler on mount via the
 *      `ToolBridge` exposed by the session, and unregisters on unmount.
 *      Registration is keyed by `handlerRef`; the reference is stable
 *      so re-renders don't re-register.
 *   5. The component renders the `<tool>` intrinsic so the collect
 *      walker picks up the declaration as it would for any other tool.
 *
 * The `deps.use` argument passed by the dispatcher is intentionally
 * ignored — React tools own their dep capture. Tools that don't need
 * tree-scoped context should use the generic `@agentick/tool` factory
 * instead.
 */

import * as React from "react";

import { createTool as baseCreateTool, type CreatedTool } from "@agentick/tool";
import type {
  ContentBlock,
  JsonSchema,
  StandardSchemaV1,
  ToolAnnotations,
  ToolExposure,
  ToolHandlerCtx,
} from "@agentick/spec";

import { useToolBridge } from "./hooks/use-tool-bridge.js";

// ============================================================================
// Spec
// ============================================================================

export interface ReactToolSpec<
  TInput = unknown,
  TDeps extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonSchema;
  readonly input?: StandardSchemaV1<TInput>;
  readonly exposure?: readonly ToolExposure[];
  readonly annotations?: ToolAnnotations;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly handlerRef?: string;
  /**
   * Render-time hook called by the `Tool` component on every render.
   * Standard React rules apply — call hooks here. The returned record
   * becomes `deps.use` for the handler on the next dispatch.
   *
   * Omit when the handler needs no tree-scoped deps; the React-flavored
   * factory still gives you the auto-register/unregister wiring.
   */
  readonly use?: () => TDeps;
  /**
   * Tool body. Receives validated input + `{ ctx, use }`. `use` is the
   * value most recently returned by `spec.use()` (or `{}` if `use` is
   * omitted or if the tool was dispatched before its component mounted).
   */
  readonly handler: (
    input: TInput,
    deps: { readonly ctx: ToolHandlerCtx; readonly use: TDeps },
  ) => Promise<readonly ContentBlock[]> | readonly ContentBlock[];
}

// ============================================================================
// Output
// ============================================================================

export interface CreatedReactTool extends CreatedTool {
  /**
   * React component that registers/unregisters the handler with the
   * session's `ToolBridge` and renders the `<tool>` intrinsic. Drop
   * inside an agent tree.
   */
  readonly Tool: React.FC;
}

// ============================================================================
// Factory
// ============================================================================

export function createTool<
  TInput = unknown,
  TDeps extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
>(spec: ReactToolSpec<TInput, TDeps>): CreatedReactTool {
  // Shared mutable cell. The Tool component writes the latest deps
  // here on every render; the handler reads from here on every
  // dispatch. Re-renders never re-register the handler.
  const useRef: { current: TDeps | undefined } = { current: undefined };

  const base = baseCreateTool<TInput>({
    name: spec.name,
    description: spec.description,
    ...(spec.inputSchema !== undefined ? { inputSchema: spec.inputSchema } : {}),
    ...(spec.input !== undefined ? { input: spec.input } : {}),
    ...(spec.exposure !== undefined ? { exposure: spec.exposure } : {}),
    ...(spec.annotations !== undefined ? { annotations: spec.annotations } : {}),
    ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
    ...(spec.handlerRef !== undefined ? { handlerRef: spec.handlerRef } : {}),
    handler: async (input, { ctx }) => {
      const captured = useRef.current ?? ({} as TDeps);
      return spec.handler(input, { ctx, use: captured });
    },
  });

  const Tool: React.FC = () => {
    const deps = spec.use?.() ?? ({} as TDeps);
    useRef.current = deps;

    const bridge = useToolBridge();

    React.useEffect(() => {
      if (!bridge) return;
      const unregister = bridge.register(base.handlerRef, base.handler, base.validator);
      return () => {
        unregister();
      };
    }, [bridge]);

    return React.createElement("tool", {
      id: base.declaration.id,
      name: base.declaration.name,
      description: base.declaration.description,
      inputSchema: base.declaration.inputSchema,
      exposure: base.declaration.exposure,
      handlerRef: base.handlerRef,
      ...(base.declaration.annotations !== undefined
        ? { annotations: base.declaration.annotations }
        : {}),
      ...(base.declaration.metadata !== undefined ? { metadata: base.declaration.metadata } : {}),
    });
  };
  Tool.displayName = `Tool(${spec.name})`;

  return { ...base, Tool };
}
