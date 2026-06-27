/**
 * Declaration intrinsic helpers — pure functions producing IR
 * declarations for the runtime-side registrations (tools, MCP
 * servers, resources, outputs) + the generation-time config
 * (SpecConfig + ProviderOptions).
 *
 * Each helper takes already-resolved props + an `idFallback` string
 * (the adapter-derived stable id, typically from the host instance's
 * `hostId`) and returns a Result discriminated by `ok`. When `ok`,
 * the `value` is the built declaration; when not, the helper carries
 * a `FormatDiagnostic` instead so the walker can surface it via the
 * Step 3a diagnostic channel.
 *
 * Mirror of the validation behavior in the (about-to-be-retired)
 * `packages-next/reconciler/src/collect/contributors/{tool,mcp,
 * resource,output,model}.ts` — same required-field guards, same
 * diagnostic codes, same emit shape.
 *
 * @see docs/proposals/v2/blueprint/39-jsx-template-walker.md
 */

import type {
  FormatDiagnostic,
  MCPDeclaration,
  MCPTransport,
  OutputDeclaration,
  ProviderOptions,
  ResourceDeclaration,
  ResponseFormat,
  SpecConfig,
  StandardSchemaV1,
  ToolAnnotations,
  ToolDeclaration,
  ToolExposure,
} from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

// ============================================================================
// Result type
// ============================================================================

/**
 * Declaration helpers return either a built value OR a diagnostic
 * the walker should emit. Helpers do NOT throw on missing required
 * fields — the diagnostic channel is the contract.
 */
export type DeclarationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly diagnostic: FormatDiagnostic };

// ============================================================================
// Tool
// ============================================================================

export interface ToolProps {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly inputSchema?: StandardSchemaV1;
  readonly outputSchema?: StandardSchemaV1;
  readonly exposure?: readonly ToolExposure[];
  readonly handlerRef?: string;
  readonly annotations?: ToolAnnotations;
  readonly metadata?: Record<string, unknown>;
}

export function toolDeclaration(
  props: ToolProps,
  idFallback: string,
  /**
   * Description fallback text — typically the textual contents of the
   * `<tool>` element's children, so authors can write JSX prose
   * inside `<tool>` and have it land in the declaration.
   */
  descriptionFallback: string,
): DeclarationResult<ToolDeclaration> {
  if (!props.name) {
    return {
      ok: false,
      diagnostic: {
        severity: "warning",
        code: "tool-missing-name",
        message: "<tool> dropped — missing `name` prop.",
      },
    };
  }
  if (!props.inputSchema) {
    return {
      ok: false,
      diagnostic: {
        severity: "warning",
        code: "tool-missing-input-schema",
        message: `<tool name="${props.name}"> dropped — missing \`inputSchema\` prop.`,
      },
    };
  }
  const description =
    props.description ?? (descriptionFallback.length > 0 ? descriptionFallback : "");
  const tool: ToolDeclaration = {
    id: props.id ?? idFallback,
    name: props.name,
    description,
    inputSchema: props.inputSchema,
    exposure: props.exposure ?? ["model"],
    ...omitUndefined({
      outputSchema: props.outputSchema,
      handlerRef: props.handlerRef,
      annotations: props.annotations,
      metadata: props.metadata,
    }),
  };
  return { ok: true, value: tool };
}

// ============================================================================
// MCP
// ============================================================================

export interface McpProps {
  readonly id?: string;
  readonly serverName?: string;
  readonly transport?: MCPTransport;
  readonly config?: Record<string, unknown>;
  readonly exposes?: readonly ("tools" | "resources" | "prompts")[];
  readonly metadata?: Record<string, unknown>;
}

export function mcpDeclaration(
  props: McpProps,
  idFallback: string,
): DeclarationResult<MCPDeclaration> {
  if (!props.serverName || !props.transport) {
    return {
      ok: false,
      diagnostic: {
        severity: "warning",
        code: "mcp-missing-fields",
        message: "<mcp> dropped — `serverName` and `transport` are both required.",
      },
    };
  }
  const mcp: MCPDeclaration = {
    id: props.id ?? idFallback,
    serverName: props.serverName,
    transport: props.transport,
    config: props.config ?? {},
    ...omitUndefined({ exposes: props.exposes, metadata: props.metadata }),
  };
  return { ok: true, value: mcp };
}

// ============================================================================
// Resource
// ============================================================================

export interface ResourceProps {
  readonly id?: string;
  readonly uri?: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly handlerRef?: string;
  readonly metadata?: Record<string, unknown>;
}

export function resourceDeclaration(
  props: ResourceProps,
  idFallback: string,
): DeclarationResult<ResourceDeclaration> {
  const resource: ResourceDeclaration = {
    id: props.id ?? idFallback,
    ...omitUndefined({
      uri: props.uri,
      name: props.name,
      description: props.description,
      mimeType: props.mimeType,
      handlerRef: props.handlerRef,
      metadata: props.metadata,
    }),
  };
  return { ok: true, value: resource };
}

// ============================================================================
// Output
// ============================================================================

export interface OutputProps {
  readonly id?: string;
  readonly schema?: StandardSchemaV1;
  readonly mode?: OutputDeclaration["mode"];
  readonly metadata?: Record<string, unknown>;
}

export function outputDeclaration(
  props: OutputProps,
  idFallback: string,
): DeclarationResult<OutputDeclaration> {
  const output: OutputDeclaration = {
    id: props.id ?? idFallback,
    ...omitUndefined({ schema: props.schema, mode: props.mode, metadata: props.metadata }),
  };
  return { ok: true, value: output };
}

// ============================================================================
// Model (SpecConfig + ProviderOptions)
// ============================================================================

export interface ModelProps {
  readonly id?: string;
  readonly ref?: string;
  readonly responseFormat?: ResponseFormat;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly metadata?: Record<string, unknown>;
  readonly providerOptions?: ProviderOptions;
}

export interface ModelConfigResult {
  readonly specConfig?: Partial<SpecConfig>;
  readonly providerOptions?: ProviderOptions;
}

/**
 * Resolve a `<model>` intrinsic to its SpecConfig + ProviderOptions
 * contribution. Both fields are optional in the result; empty config
 * (e.g., a bare `<model />`) returns `{}`. Unlike the other
 * declaration helpers, `<model>` never produces a diagnostic — every
 * field is optional and the walker leaves the result as-is.
 */
export function modelConfig(props: ModelProps): ModelConfigResult {
  const draft: { -readonly [K in keyof SpecConfig]?: SpecConfig[K] } = {};
  if (props.id !== undefined) draft.model = { kind: "by-id", id: props.id };
  else if (props.ref !== undefined) draft.model = { kind: "by-ref", ref: props.ref };
  if (props.responseFormat !== undefined) draft.responseFormat = props.responseFormat;
  if (props.maxOutputTokens !== undefined) draft.maxOutputTokens = props.maxOutputTokens;
  if (props.temperature !== undefined) draft.temperature = props.temperature;
  if (props.metadata !== undefined) draft.metadata = props.metadata;
  const partial: Partial<SpecConfig> = draft;
  const out: { specConfig?: Partial<SpecConfig>; providerOptions?: ProviderOptions } = {};
  if (Object.keys(partial).length > 0) out.specConfig = partial;
  if (props.providerOptions && Object.keys(props.providerOptions).length > 0) {
    out.providerOptions = props.providerOptions;
  }
  return out;
}
