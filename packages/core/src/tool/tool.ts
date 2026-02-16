/**
 * Tool Creation
 *
 * createTool() returns a ToolClass that can be:
 * 1. Passed directly to models: engine.execute({ tools: [MyTool] })
 * 2. Run directly: await MyTool.run(input)
 * 3. Used in JSX: <MyTool />
 *
 * Core tool types (ToolMetadata, ToolDefinition, ExecutableTool, etc.)
 * are defined in types.ts to keep them centralized.
 */

import React, { useEffect, useRef } from "react";
import { createEngineProcedure, isProcedure } from "../procedure";
import type { ExtractArgs, Middleware, Procedure } from "@agentick/kernel";
import type { ProviderToolOptions, LibraryToolOptions } from "../types";
import {
  ToolExecutionType,
  ToolIntent,
  type ClientToolDefinition,
  type ToolDefinition as BaseToolDefinition,
} from "@agentick/shared/tools";
import type { ContentBlock } from "@agentick/shared/blocks";
import { type RecoveryAction, type TickState } from "../component/component";
import type { TickResult } from "../hooks/types";
import type { COM } from "../com/object-model";
import type { COMInput } from "../com/types";
import type { JSX } from "../jsx/jsx-runtime";
import type { ComponentBaseProps } from "../jsx/jsx-types";
import type { CompiledStructure } from "../compiler/types";
import { useCom, useTickState, useOnTickStart, useOnTickEnd, useAfterCompile } from "../hooks";

// Re-export for convenience
export {
  ToolIntent,
  ToolExecutionType,
  type ToolCall,
  type ToolResult,
  type ToolConfirmationResult,
} from "@agentick/shared/tools";

// Re-export wire protocol type from protocol.ts (via main shared export)
export type { ToolConfirmationResponse } from "@agentick/shared";
export type { BaseToolDefinition, ClientToolDefinition };

// ============================================================================
// Types
// ============================================================================

/**
 * Version-agnostic Zod schema type.
 * Allows different Zod versions to work together without "excessively deep" errors.
 */
export interface ZodSchema<T = unknown> {
  parse: (data: unknown) => T;
  safeParse: (data: unknown) => { success: boolean; data?: T; error?: unknown };
  _output: T;
}

/**
 * Tool handler function signature.
 * Takes typed input and an optional COM for accessing agent state.
 *
 * When called during agent execution (model calls the tool), `ctx` is provided.
 * When called directly via `MyTool.run(input)`, `ctx` is undefined.
 */
export type ToolHandler<TInput = any, TOutput extends ContentBlock[] = ContentBlock[]> = (
  input: TInput,
  ctx?: COM,
) => TOutput | Promise<TOutput>;

/**
 * Core dependencies auto-populated by createTool when rendered in a component tree.
 * Always includes `ctx` (COM). Additional fields come from the tool's `use()` hook.
 */
export interface ToolCoreDeps {
  ctx: COM;
}

/**
 * Tool handler with deps — used when `use()` is provided on createTool.
 * The handler receives typed input and optional deps (core + custom from use()).
 *
 * When rendered in JSX: deps is populated (core + use() return value).
 * When called directly via `.run(input)`: deps is undefined.
 */
export type ToolHandlerWithDeps<
  TInput = any,
  TOutput extends ContentBlock[] = ContentBlock[],
  TDeps extends Record<string, any> = {},
> = (input: TInput, deps?: ToolCoreDeps & TDeps) => TOutput | Promise<TOutput>;

/**
 * Options for createTool().
 *
 * Mirrors ToolMetadata but with additional creation-time options
 * (handler, middleware, component lifecycle hooks).
 */
export interface CreateToolOptions<
  TInput = any,
  TOutput extends ContentBlock[] = ContentBlock[],
  TDeps extends Record<string, any> = {},
> {
  // === Core Metadata ===

  /** Tool name (used by model to call the tool) */
  name: string;

  /** Description shown to the model */
  description: string;

  /** Zod schema for input validation */
  input: ZodSchema<TInput>;

  /**
   * Optional Zod schema for output validation.
   * Used for type-safe tool composition, workflow orchestration,
   * and runtime validation of handler return values.
   */
  output?: ZodSchema<TOutput>;

  // === Execution Configuration ===

  /**
   * Handler function that executes the tool.
   * Receives typed input and an optional COM for accessing agent state.
   *
   * When called during agent execution, `ctx` is provided so the handler
   * can set state, publish to channels, read context, etc.
   * When called directly via `MyTool.run(input)`, `ctx` is undefined.
   *
   * Optional for CLIENT and PROVIDER tools (no server-side execution).
   *
   * @example
   * ```typescript
   * handler: async (input, ctx) => {
   *   const result = doSomething(input);
   *   ctx?.setState("lastResult", result);
   *   return [{ type: "text", text: JSON.stringify(result) }];
   * }
   * ```
   */
  handler?: ToolHandler<TInput, TOutput>;

  /**
   * Execution type (SERVER, CLIENT, MCP, PROVIDER).
   * Default: SERVER
   */
  type?: ToolExecutionType;

  /**
   * Tool intent (RENDER, ACTION, COMPUTE).
   * Helps clients decide how to handle/render tool calls.
   * Default: COMPUTE
   */
  intent?: ToolIntent;

  // === Client Tool Configuration ===

  /**
   * Whether execution should wait for client response.
   * Only applicable for CLIENT type tools.
   * - true: Server pauses until tool_result received (e.g., forms)
   * - false: Server continues with defaultResult (e.g., charts)
   * Default: false
   */
  requiresResponse?: boolean;

  /**
   * Timeout in ms when waiting for client response.
   * Only applicable when requiresResponse is true.
   * Default: 30000
   */
  timeout?: number;

  /**
   * Default result when requiresResponse is false.
   * Returned immediately for render tools.
   * Default: [{ type: 'text', text: '[{name} rendered on client]' }]
   */
  defaultResult?: ContentBlock[];

  // === Confirmation Configuration ===

  /**
   * Whether execution requires user confirmation before running.
   * Applies to any tool type (SERVER, CLIENT, MCP).
   *
   * - boolean: Always require (true) or never require (false)
   * - function: Conditional - receives input, returns whether confirmation needed.
   *   Can be async to check persisted "always allow" state.
   *   Use Context.get() inside the function to access execution context.
   *
   * Default: false
   *
   * @example
   * ```typescript
   * // Always require confirmation
   * requiresConfirmation: true,
   *
   * // Conditional - check persisted preferences
   * requiresConfirmation: async (input) => {
   *   const ctx = context();
   *   const prefs = await getPrefs(ctx.user?.id);
   *   return !prefs.alwaysAllow.includes('my_tool');
   * },
   * ```
   */
  requiresConfirmation?: boolean | ((input: TInput) => boolean | Promise<boolean>);

  /**
   * Message to show user when requesting confirmation.
   * Can be a string or a function that receives the input.
   * Default: "Allow {tool_name} to execute?"
   *
   * @example
   * ```typescript
   * confirmationMessage: (input) => `Delete file "${input.path}"?`,
   * ```
   */
  confirmationMessage?: string | ((input: TInput) => string);

  /**
   * Short summary string for tool call indicators in the TUI.
   * Receives the tool input, returns a human-readable summary
   * (e.g. file path, command preview).
   */
  displaySummary?: (input: TInput) => string;

  /**
   * Async function that computes preview metadata for the confirmation UI.
   * Called when confirmation is required, before the user prompt.
   * Receives tool input + resolved deps (from use()).
   * Returns metadata attached to the confirmation request (e.g. diff preview).
   */
  confirmationPreview?: (input: TInput, deps: TDeps) => Promise<Record<string, unknown>>;

  // === Provider Configuration ===

  /**
   * Provider-specific tool options.
   * Keyed by provider name (openai, google, anthropic, etc.).
   * Used by adapters when converting tools.
   */
  providerOptions?: ProviderToolOptions;

  /**
   * MCP server configuration (for MCP tools).
   */
  mcpConfig?: {
    serverUrl?: string;
    serverName?: string;
    transport?: "stdio" | "sse" | "websocket";
    [key: string]: any;
  };

  // === User-Invocable Configuration ===

  /** If true, tool is not included in model tool definitions. For user-invocable-only tools. */
  commandOnly?: boolean;

  /** Alternative names for user dispatch (e.g. ["mount"] for "add-dir"). */
  aliases?: string[];

  // === Middleware ===

  /** Middleware applied to handler execution */
  middleware?: Middleware[];

  // === Render-time Hook ===

  /**
   * Hook function that runs at render time inside the component tree.
   * Has full access to React hooks (useContext, useData, custom hooks).
   *
   * Return value is merged with core deps ({ ctx }) and passed to the
   * handler as the second argument. This bridges render-time context
   * (tree-scoped) into execution-time handlers.
   *
   * Only runs when the tool is rendered in JSX (`<MyTool />`).
   * When called directly via `.run(input)`, `use()` does not run
   * and the handler's deps parameter is undefined.
   *
   * @example
   * ```typescript
   * const Shell = createTool({
   *   name: 'shell',
   *   description: 'Execute a command in the sandbox',
   *   input: z.object({ command: z.string() }),
   *   use: () => ({ sandbox: useSandbox() }),
   *   handler: async ({ command }, deps) => {
   *     const result = await deps!.sandbox.exec(command);
   *     return [{ type: 'text', text: result.stdout }];
   *   },
   * });
   * ```
   */
  use?: () => TDeps;

  // === Component Lifecycle Hooks (for JSX usage) ===
  // All callbacks receive data first, ctx (context) last.

  onMount?: (ctx: COM) => void | Promise<void>;
  onUnmount?: (ctx: COM) => void | Promise<void>;
  onStart?: (ctx: COM) => void | Promise<void>;
  onTickStart?: (tickState: TickState, ctx: COM) => void | Promise<void>;
  onTickEnd?: (result: TickResult, ctx: COM) => void | Promise<void>;
  onComplete?: (finalState: COMInput, ctx: COM) => void | Promise<void>;
  onError?: (tickState: TickState, ctx: COM) => RecoveryAction | void;
  render?: (tickState: TickState, ctx: COM) => JSX.Element | null;
  onAfterCompile?: (compiled: CompiledStructure, ctx: COM) => void | Promise<void>;
}

/**
 * A ToolClass is both:
 * - An ExecutableTool (via static metadata/run) - can be passed to models
 * - A functional component - can be used in JSX
 *
 * This enables the three usage patterns:
 * - engine.execute({ tools: [MyTool] })  -- passes static metadata/run
 * - await MyTool.run(input)              -- calls static run procedure
 * - <MyTool />                           -- renders component that registers tool
 */
/**
 * Fields that can be overridden via JSX props on tool components.
 * Notably excludes `input` (schema) — overriding schema without the handler is a type-safety foot-gun.
 * To change the schema, create a new tool.
 */
const OVERRIDABLE_FIELDS = [
  "name",
  "description",
  "requiresConfirmation",
  "confirmationMessage",
  "intent",
  "type",
  "providerOptions",
  "libraryOptions",
] as const;

type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

/**
 * Props that can be overridden on tool components via JSX.
 * Derived from OVERRIDABLE_FIELDS — single source of truth.
 */
export type ToolPropOverrides = Partial<Pick<ToolMetadata, OverridableField>>;

export interface ToolClass<TInput = any> {
  /** Tool metadata (static property) */
  metadata: ToolMetadata<TInput>;

  /** Run procedure (static property). Undefined for client-only tools. */
  run?: Procedure<ToolHandler<TInput>>;

  /** Functional component that registers the tool on mount */
  (props?: ComponentBaseProps & ToolPropOverrides): React.ReactElement | null;
}

/**
 * ToolClass with run guaranteed to be defined (when handler is provided).
 */
export interface RunnableToolClass<TInput = any> extends ToolClass<TInput> {
  run: Procedure<ToolHandler<TInput>>;
}

// ============================================================================
// createTool
// ============================================================================

/**
 * Creates a tool that can be passed to models, run directly, or used in JSX.
 *
 * The returned class has static `metadata` and `run` properties making it
 * a valid ExecutableTool, while also being instantiable as a Component.
 *
 * @example
 * ```typescript
 * const Calculator = createTool({
 *   name: 'calculator',
 *   description: 'Performs mathematical calculations',
 *   input: z.object({
 *     expression: z.string().describe('Math expression to evaluate')
 *   }),
 *   handler: async ({ expression }) => {
 *     const result = eval(expression);
 *     return [{ type: 'text', text: String(result) }];
 *   },
 * });
 *
 * // Pattern 1: Pass to model
 * engine.execute({
 *   messages: [...],
 *   tools: [Calculator],
 * });
 *
 * // Pattern 2: Run directly
 * const result = await Calculator.run({ expression: '2 + 2' });
 *
 * // Pattern 3: Use in JSX (registers tool when component mounts)
 * function MyAgent() {
 *   return (
 *     <>
 *       <Calculator />
 *       <Model />
 *     </>
 *   );
 * }
 * ```
 *
 * @example Client tool (no handler)
 * ```typescript
 * const RenderChart = createTool({
 *   name: 'render_chart',
 *   description: 'Renders a chart in the UI',
 *   input: z.object({
 *     type: z.enum(['line', 'bar', 'pie']),
 *     data: z.array(z.object({ label: z.string(), value: z.number() })),
 *   }),
 *   type: ToolExecutionType.CLIENT,
 *   intent: ToolIntent.RENDER,
 *   requiresResponse: false,
 *   defaultResult: [{ type: 'text', text: '[Chart rendered]' }],
 * });
 * ```
 */
// Overload: use() + handler provided → deps inferred from use(), run defined
export function createTool<
  TInput = any,
  TOutput extends ContentBlock[] = ContentBlock[],
  TDeps extends Record<string, any> = Record<string, any>,
>(
  options: Omit<CreateToolOptions<TInput, TOutput, TDeps>, "handler" | "use"> & {
    handler: ToolHandlerWithDeps<TInput, TOutput, TDeps>;
    use: () => TDeps;
  },
): RunnableToolClass<TInput>;

// Overload: handler provided (no use()) → standard handler, run defined
export function createTool<TInput = any, TOutput extends ContentBlock[] = ContentBlock[]>(
  options: CreateToolOptions<TInput, TOutput> & { handler: ToolHandler<TInput> },
): RunnableToolClass<TInput>;

// Overload: handler not provided → run is undefined
export function createTool<TInput = any, TOutput extends ContentBlock[] = ContentBlock[]>(
  options: CreateToolOptions<TInput, TOutput> & { handler?: undefined },
): ToolClass<TInput>;

// Implementation
export function createTool<TInput = any, TOutput extends ContentBlock[] = ContentBlock[]>(
  options: CreateToolOptions<TInput, TOutput>,
): ToolClass<TInput> {
  // Build metadata from options
  const metadata: ToolMetadata<TInput, TOutput> = {
    name: options.name,
    description: options.description,
    input: options.input,
    output: options.output,
    type: options.type,
    intent: options.intent,
    requiresResponse: options.requiresResponse,
    timeout: options.timeout,
    defaultResult: options.defaultResult,
    requiresConfirmation: options.requiresConfirmation,
    confirmationMessage: options.confirmationMessage,
    displaySummary: options.displaySummary,
    confirmationPreview: options.confirmationPreview,
    providerOptions: options.providerOptions,
    mcpConfig: options.mcpConfig,
    commandOnly: options.commandOnly,
    aliases: options.aliases,
  };

  // Procedure options shared between static run and instance run
  const procedureOptions = {
    name: "tool:run" as const,
    metadata: {
      type: "tool",
      toolName: options.name,
      id: options.name,
      operation: "run",
    },
    middleware: options.middleware || [],
    executionBoundary: "child" as const,
    executionType: "tool",
  };

  // Create run procedure if handler is provided
  // This is the static run — used for direct execution (MyTool.run(input))
  // and as fallback when use() is not provided in JSX.
  const run = options.handler
    ? isProcedure(options.handler)
      ? options.handler
      : createEngineProcedure<ToolHandler<TInput>>(procedureOptions, options.handler)
    : undefined;

  // Create functional component with static tool properties
  // Using a functional component instead of a class ensures compatibility
  // with React's reconciler (class components must extend React.Component)
  const ToolComponent = function ToolComponent(
    props: ComponentBaseProps & ToolPropOverrides,
  ): React.ReactElement | null {
    // Merge JSX prop overrides with default metadata
    // Props take priority over createTool defaults
    const overrides: Record<string, unknown> = {};
    for (const field of OVERRIDABLE_FIELDS) {
      if (props[field as keyof typeof props] !== undefined) {
        overrides[field] = props[field as keyof typeof props];
      }
    }
    const effectiveMetadata = { ...metadata, ...overrides } as ToolMetadata<TInput, TOutput>;
    const ctx = useCom();
    // Note: useTickState returns hooks/types.ts TickState, but lifecycle callbacks
    // expect component/component.ts TickState. They're compatible at runtime,
    // so we use type assertion. The hooks version is a simplified subset.
    const tickState = useTickState() as unknown as TickState;

    // === Context injection: all JSX-rendered tools get ctx/deps from the component tree ===
    // The tool executor does NOT pass ctx — the component is the source of truth.

    // Capture ctx ref (always up-to-date for instance procedure closure)
    const ctxRef = useRef<COM>(ctx);
    ctxRef.current = ctx;

    // Call use() every render to capture fresh hook values (tree-scoped).
    // This is safe: options.use is fixed per tool definition, so hook call
    // order is consistent across renders (no rules-of-hooks violation).
    const userDeps = options.use?.();

    // Build deps: core values (ctx) + user's use() return
    const depsRef = useRef<(ToolCoreDeps & Record<string, any>) | undefined>(undefined);
    if (options.use) {
      depsRef.current = { ctx, ...userDeps };
    }

    // Create instance procedure once (stable via ref).
    // ALL tools with handlers get an instance procedure so context comes from
    // the component tree, not from the executor. This is what makes
    // `toolProcedure(input)` work without a second arg.
    const instanceRunRef = useRef<any>(null);
    if (options.handler && !instanceRunRef.current) {
      if (isProcedure(options.handler)) {
        instanceRunRef.current = options.handler;
      } else if (options.use) {
        // use() provided — inject full deps (ToolCoreDeps & user deps)
        instanceRunRef.current = createEngineProcedure(procedureOptions, async (...args: any[]) =>
          (options.handler as any)(args[0], depsRef.current),
        );
      } else {
        // No use() — inject ctx from component tree (preserves handler(input, ctx?) signature)
        instanceRunRef.current = createEngineProcedure(procedureOptions, async (...args: any[]) =>
          (options.handler as any)(args[0], ctxRef.current),
        );
      }
    }

    // Use instance procedure when available, otherwise static run (config tools fallback)
    const effectiveRun = instanceRunRef.current || run;

    // Preview closure for confirmation UI.
    // Reads through depsRef (not a direct capture) because use() may return
    // new values on re-render. The ref ensures preview always sees the latest
    // hook-resolved dependencies (e.g., useSandbox()).
    //
    // Only available for JSX-rendered tools (in the component tree).
    // Config tools don't go through the component lifecycle, so they
    // can't resolve use() deps for preview.
    const previewFn =
      options.confirmationPreview && depsRef.current
        ? (input: any) => options.confirmationPreview!(input, depsRef.current as any)
        : undefined;

    // Track lifecycle callbacks (should only fire once per component lifecycle)
    const hasCalledMountRef = useRef(false);

    // Call onMount/onStart lifecycle hooks once
    useEffect(() => {
      if (!hasCalledMountRef.current) {
        hasCalledMountRef.current = true;
        if (options.onMount) {
          Promise.resolve(options.onMount(ctx)).catch(console.error);
        }
        if (options.onStart) {
          Promise.resolve(options.onStart(ctx)).catch(console.error);
        }
      }

      return () => {
        if (options.onUnmount) {
          Promise.resolve(options.onUnmount(ctx)).catch(console.error);
        }
      };
    }, [ctx]);

    // Tick lifecycle hooks - data first, ctx last
    if (options.onTickStart) {
      useOnTickStart((hookTickState, hookCtx) => {
        if (options.onTickStart) {
          Promise.resolve(options.onTickStart(hookTickState, hookCtx)).catch(console.error);
        }
      });
    }

    if (options.onTickEnd) {
      useOnTickEnd((result, hookCtx) => {
        if (options.onTickEnd) {
          Promise.resolve(options.onTickEnd(result, hookCtx)).catch(console.error);
        }
      });
    }

    if (options.onAfterCompile) {
      useAfterCompile((compiled, hookCtx) => {
        if (options.onAfterCompile) {
          Promise.resolve(options.onAfterCompile(compiled, hookCtx)).catch(console.error);
        }
      });
    }

    // Render a <tool> element for the collector to find
    // This is the declarative approach - tools are collected from the tree
    const toolElement = React.createElement("tool", {
      name: effectiveMetadata.name,
      description: effectiveMetadata.description,
      schema: effectiveMetadata.input,
      handler: effectiveRun,
      preview: previewFn,
      metadata: effectiveMetadata,
    });

    // If custom render provided, wrap both tool element and render output
    if (options.render) {
      const renderOutput = options.render(tickState, ctx);
      return React.createElement(React.Fragment, null, toolElement, renderOutput);
    }

    return toolElement;
  };

  // Attach static properties to make it a valid ToolClass
  (ToolComponent as any).metadata = metadata;
  (ToolComponent as any).run = run;

  return ToolComponent as unknown as ToolClass<TInput>;
}

/**
 * Tool definition in provider-compatible format (JSON Schema).
 * This is what gets passed to model adapters.
 *
 * Extends the base ToolDefinition from @agentick/shared with backend-specific fields.
 */
export interface ToolDefinition extends BaseToolDefinition {
  /**
   * Provider-specific tool configurations.
   * Keyed by provider name (e.g., 'openai', 'google', 'anthropic').
   * Adapters will use their provider-specific config when converting tools.
   * Each adapter can extend this type using module augmentation.
   */
  providerOptions?: ProviderToolOptions;
  /**
   * Library-specific tool configurations.
   * Keyed by library name (e.g., 'ai-sdk', 'langchain', 'llamaindex').
   * Used by adapters for library-specific tool behavior (timeouts, callbacks, etc.).
   * Each adapter can extend this type using module augmentation.
   */
  libraryOptions?: LibraryToolOptions;
  /**
   * MCP-specific configuration (only relevant if type === 'mcp').
   * Contains connection info and MCP server details.
   */
  mcpConfig?: {
    serverUrl?: string;
    serverName?: string;
    transport?: "stdio" | "sse" | "websocket";
    [key: string]: any;
  };
}

export interface ToolMetadata<TInput = any, TOutput = any> {
  name: string;
  description: string;
  input: ZodSchema<TInput>;
  /**
   * Optional Zod schema for output validation.
   * Used for type-safe tool composition and workflow orchestration.
   */
  output?: ZodSchema<TOutput>;
  /**
   * Tool execution type. Determines how the tool is executed.
   * Default: SERVER (engine executes tool.run on server).
   */
  type?: ToolExecutionType;
  /**
   * Tool intent describes what the tool does (render, action, compute).
   * Used by clients to determine how to render/handle tool calls.
   * Default: COMPUTE
   */
  intent?: ToolIntent;
  /**
   * Whether execution should wait for client response.
   * Only applicable for CLIENT type tools.
   * - true: Server pauses and waits for tool_result from client (e.g., forms)
   * - false: Server continues immediately with defaultResult (e.g., charts)
   * Default: false
   */
  requiresResponse?: boolean;
  /**
   * Timeout in milliseconds when waiting for client response.
   * Only applicable when requiresResponse is true.
   * Default: 30000 (30 seconds)
   */
  timeout?: number;
  /**
   * Default result to use when requiresResponse is false.
   * Returned immediately for render tools that don't need client feedback.
   * Default: [{ type: 'text', text: '[{tool_name} rendered on client]' }]
   */
  defaultResult?: ContentBlock[];
  /**
   * Whether execution requires user confirmation before running.
   * Applies to any tool type (SERVER, CLIENT, MCP).
   *
   * - boolean: Always require (true) or never require (false)
   * - function: Conditional - receives input, returns whether confirmation needed.
   *   Can be async to check persisted "always allow" state.
   *   Use Context.get() inside the function to access execution context.
   *
   * Default: false
   */
  requiresConfirmation?: boolean | ((input: any) => boolean | Promise<boolean>);
  /**
   * Message to show user when requesting confirmation.
   * Can be a string or a function that receives the input.
   * Default: "Allow {tool_name} to execute?"
   */
  confirmationMessage?: string | ((input: any) => string);
  /** Short summary string for tool call indicators. */
  displaySummary?: (input: any) => string;
  /** Async preview metadata for confirmation UI (e.g. diff). */
  confirmationPreview?: (input: any, deps: any) => Promise<Record<string, unknown>>;
  /**
   * Provider-specific tool configurations.
   * Keyed by provider name (e.g., 'openai', 'google', 'anthropic').
   * Preserved when converting to ToolDefinition.
   * Each adapter can extend this type using module augmentation.
   */
  providerOptions?: ProviderToolOptions;
  /**
   * Library-specific tool configurations.
   * Keyed by library name (e.g., 'ai-sdk', 'langchain', 'llamaindex').
   * Used by adapters for library-specific tool behavior (timeouts, callbacks, etc.).
   * Each adapter can extend this type using module augmentation.
   */
  libraryOptions?: LibraryToolOptions;
  /**
   * MCP-specific configuration (only relevant if type === 'mcp').
   * Contains connection info and MCP server details.
   */
  mcpConfig?: {
    serverUrl?: string;
    serverName?: string;
    transport?: "stdio" | "sse" | "websocket";
    [key: string]: any;
  };

  /** If true, tool is not included in model tool definitions. For user-invocable-only tools. */
  commandOnly?: boolean;

  /** Alternative names for user dispatch (e.g. ["mount"] for "add-dir"). */
  aliases?: string[];
}

export interface ExecutableTool<
  THandler extends (input: any, ctx?: COM) => ContentBlock[] | Promise<ContentBlock[]> = (
    input: any,
    ctx?: COM,
  ) => ContentBlock[] | Promise<ContentBlock[]>,
> {
  metadata: ToolMetadata<ExtractArgs<THandler>[0]>;
  run?: Procedure<THandler>; // Optional - tools without handlers (e.g., client tools) don't need run
  preview?: (input: any) => Promise<Record<string, unknown>>; // Confirmation preview closure
}

// ClientToolDefinition is now exported from '@agentick/shared'

/**
 * Convert ClientToolDefinition to ToolDefinition for engine use.
 */
export function clientToolToDefinition(clientTool: ClientToolDefinition): ToolDefinition {
  return {
    name: clientTool.name,
    description: clientTool.description,
    input: clientTool.input,
    output: clientTool.output,
    type: ToolExecutionType.CLIENT,
    intent: clientTool.intent ?? ToolIntent.RENDER,
    requiresResponse: clientTool.requiresResponse ?? false,
    timeout: clientTool.timeout ?? 30000,
    defaultResult: clientTool.defaultResult ?? [
      { type: "text", text: `[${clientTool.name} rendered on client]` },
    ],
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Type guard: checks if a value is a ToolClass.
 */
export function isToolClass(value: any): value is ToolClass {
  return value && typeof value === "function" && "metadata" in value && value.metadata?.name;
}

/**
 * Extract ExecutableTool from a ToolClass.
 * Useful when you need just the metadata/run without the component.
 */
export function toExecutableTool(toolClass: ToolClass): ExecutableTool {
  return {
    metadata: toolClass.metadata,
    run: toolClass.run,
  } as ExecutableTool;
}

/**
 * Check if value implements ExecutableTool interface.
 */
export function isExecutableTool(value: any): value is ExecutableTool {
  return (
    value &&
    typeof value === "object" &&
    "metadata" in value &&
    value.metadata?.name &&
    value.metadata?.description &&
    value.metadata?.input
  );
}
