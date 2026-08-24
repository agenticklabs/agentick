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
  ProviderToolOptions,
  StandardSchemaV1,
  ToolAnnotations,
  ToolExposure,
  ToolHandlerCtx,
  ToolHandlerResult,
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
  /** ONE sentence: what the tool does. Static, call-independent. */
  readonly summary?: string;
  /** Capability-tree path (`["api", "jobs"]`); usually stamped by `createToolGroup`. */
  readonly group?: readonly string[];
  /**
   * Standard-Schema-compliant validator. Drives BOTH runtime
   * validation and the wire JSON Schema (via `toJsonSchema()`).
   * Defaults to `jsonSchema({ type: "object" })` when omitted.
   */
  readonly inputSchema?: StandardSchemaV1<unknown, TInput>;
  /**
   * Optional output schema. Declares the handler's structured result
   * shape. Same Standard-Schema acceptance as `inputSchema`. Emitted
   * to the model as `outputSchema` on the tool definition.
   */
  readonly outputSchema?: StandardSchemaV1;
  readonly exposure?: readonly ToolExposure[];
  /**
   * Alternate dispatch names. `session.tools.dispatch(alias, input)` resolves to
   * this tool. Threaded onto `ToolDeclaration.aliases`.
   */
  readonly aliases?: readonly string[];
  readonly annotations?: ToolAnnotations;
  /**
   * Per-tool provider-specific options (OpenAI `strict`, Anthropic per-tool
   * `cache_control`, …). Threaded onto `ToolDeclaration.providerOptions`.
   */
  readonly providerOptions?: ProviderToolOptions;
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
  ) => ToolHandlerResult;
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
    ...(spec.summary !== undefined ? { summary: spec.summary } : {}),
    ...(spec.group !== undefined ? { group: spec.group } : {}),
    ...(spec.inputSchema !== undefined ? { inputSchema: spec.inputSchema } : {}),
    ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
    ...(spec.exposure !== undefined ? { exposure: spec.exposure } : {}),
    ...(spec.aliases !== undefined ? { aliases: spec.aliases } : {}),
    ...(spec.annotations !== undefined ? { annotations: spec.annotations } : {}),
    ...(spec.providerOptions !== undefined ? { providerOptions: spec.providerOptions } : {}),
    ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
    ...(spec.handlerRef !== undefined ? { handlerRef: spec.handlerRef } : {}),
    handler: (input, { ctx }) => {
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
      // `base` is always server-handled here — this factory passes a
      // `handler` to `baseCreateTool` unconditionally, so handlerRef /
      // handler / validator are always present (only handler-less
      // `createTool` leaves them undefined).
      const unregister = bridge.register(base.handlerRef!, base.handler!, base.validator!);
      return () => {
        unregister();
      };
    }, [bridge]);

    return React.createElement("tool", {
      id: base.declaration.id,
      name: base.declaration.name,
      description: base.declaration.description,
      ...(base.declaration.summary !== undefined ? { summary: base.declaration.summary } : {}),
      ...(base.declaration.group !== undefined ? { group: base.declaration.group } : {}),
      inputSchema: base.declaration.inputSchema,
      ...(base.declaration.outputSchema !== undefined
        ? { outputSchema: base.declaration.outputSchema }
        : {}),
      exposure: base.declaration.exposure,
      ...(base.declaration.aliases !== undefined ? { aliases: base.declaration.aliases } : {}),
      handlerRef: base.handlerRef,
      ...(base.declaration.annotations !== undefined
        ? { annotations: base.declaration.annotations }
        : {}),
      ...(base.declaration.providerOptions !== undefined
        ? { providerOptions: base.declaration.providerOptions }
        : {}),
      ...(base.declaration.metadata !== undefined ? { metadata: base.declaration.metadata } : {}),
    });
  };
  Tool.displayName = `Tool(${spec.name})`;

  return { ...base, Tool };
}
