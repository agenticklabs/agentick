/**
 * Declaration-mode dispatch — the path for intrinsics that produce
 * runtime registrations (`<tool>` / `<mcp>` / `<resource>` /
 * `<output>`) or generation-time config (`<model>`) rather than
 * `ContentBlock`s or `ContextEntry`s.
 *
 * The output of these intrinsics lands on different `RenderedTree`
 * slots than block-mode dispatch:
 *
 *   - `<tool>`     → `tree.declarations.tools`
 *   - `<mcp>`      → `tree.declarations.mcps`
 *   - `<resource>` → `tree.declarations.resources`
 *   - `<output>`   → `tree.declarations.outputs`
 *   - `<model>`    → `tree.config` + `tree.providerOptions`
 *
 * That architectural distinction (different IR targets, different
 * consumers — runtime executor + provider adapter, not the model
 * context pipeline) is the reason this lives in its own file from
 * `dispatch-block.ts`.
 *
 * TODO(adr-39-followup): If any of these intrinsics ever grows a
 * reactive concern — e.g., `<Resource>` wants render-time handler
 * closure capture the way `<Tool>` does today — introduce an
 * analogous `XBridge` mirroring `ToolBridge` (register/unregister
 * for handlers). The DECLARATION still flows through this walker
 * dispatch; the new bridge only handles the reactive part. The
 * pattern is documented in
 * `@agentick/reconciler-react-next/src/react/create-tool.tsx`.
 */

import {
  mcpDeclaration,
  modelConfig,
  outputDeclaration,
  resourceDeclaration,
  toolDeclaration,
  type McpProps,
  type ModelProps,
  type OutputProps,
  type ResourceProps,
  type ToolProps,
} from "@agentick/compiler-next";
import type {
  FormatDiagnostic,
  MCPDeclaration,
  MCPTransport,
  OutputDeclaration,
  ResourceDeclaration,
  ResponseFormat,
  ToolAnnotations,
  ToolDeclaration,
  ToolExposure,
} from "@agentick/spec-next";

import type { WalkResult } from "./walk.js";

/**
 * The lowercase tag names this dispatch owns. The walker checks
 * membership here BEFORE block-mode dispatch — `<tool>` would
 * otherwise be eaten by block-mode's role-shorthand fall-through.
 */
const DECLARATION_TAGS: ReadonlySet<string> = new Set([
  "tool",
  "mcp",
  "resource",
  "output",
  "model",
]);

export function isDeclarationTag(tag: string): boolean {
  return DECLARATION_TAGS.has(tag);
}

/**
 * Dispatch a declaration intrinsic. `inner` is the result of walking
 * the element's children (declaration intrinsics may carry descriptive
 * prose — `<tool>Use this when…</tool>` — that feeds the declaration's
 * `description` fallback). `hostId` is the host instance's stable id,
 * used as the id-fallback for declarations without an explicit `id`
 * prop.
 *
 * Returns a `WalkResult` carrying ONLY the declaration contribution
 * plus any diagnostic from validation. The caller (walk.ts) folds
 * this into the running accumulator.
 */
export function dispatchDeclaration(
  tag: string,
  props: Readonly<Record<string, unknown>>,
  inner: WalkResult,
  hostId: string,
): WalkResult {
  switch (tag) {
    case "tool":
      return toolCase(props, inner, hostId);
    case "mcp":
      return mcpCase(props, hostId);
    case "resource":
      return resourceCase(props, hostId);
    case "output":
      return outputCase(props, hostId);
    case "model":
      return modelCase(props);
    default:
      // unreachable — walker checks isDeclarationTag first
      throw new Error(`dispatchDeclaration: unknown declaration tag <${tag}>`);
  }
}

// ────────── Per-case handlers ──────────

function toolCase(
  props: Readonly<Record<string, unknown>>,
  inner: WalkResult,
  hostId: string,
): WalkResult {
  const description = innerText(inner.blocks);
  const result = toolDeclaration(narrowToolProps(props), `tool.${hostId}`, description);
  if (!result.ok) return diagnosticOnly(result.diagnostic);
  return single<ToolDeclaration>("tools", result.value);
}

function mcpCase(props: Readonly<Record<string, unknown>>, hostId: string): WalkResult {
  const result = mcpDeclaration(narrowMcpProps(props), `mcp.${hostId}`);
  if (!result.ok) return diagnosticOnly(result.diagnostic);
  return single<MCPDeclaration>("mcps", result.value);
}

function resourceCase(props: Readonly<Record<string, unknown>>, hostId: string): WalkResult {
  const result = resourceDeclaration(narrowResourceProps(props), `resource.${hostId}`);
  if (!result.ok) return diagnosticOnly(result.diagnostic);
  return single<ResourceDeclaration>("resources", result.value);
}

function outputCase(props: Readonly<Record<string, unknown>>, hostId: string): WalkResult {
  const result = outputDeclaration(narrowOutputProps(props), `output.${hostId}`);
  if (!result.ok) return diagnosticOnly(result.diagnostic);
  return single<OutputDeclaration>("outputs", result.value);
}

function modelCase(props: Readonly<Record<string, unknown>>): WalkResult {
  const out = modelConfig(narrowModelProps(props));
  const result: {
    entries: readonly [];
    blocks: readonly [];
    specConfig?: typeof out.specConfig;
    providerOptions?: typeof out.providerOptions;
  } = { entries: [], blocks: [] };
  if (out.specConfig) result.specConfig = out.specConfig;
  if (out.providerOptions) result.providerOptions = out.providerOptions;
  return result;
}

// ────────── Tiny helpers ──────────

function single<T>(slot: "tools" | "mcps" | "resources" | "outputs", value: T): WalkResult {
  // The slot has the same name on both `MutableWalkAccumulator` and
  // `WalkResult`; one-key object literal keyed dynamically.
  return { entries: [], blocks: [], [slot]: [value] } as unknown as WalkResult;
}

function diagnosticOnly(d: FormatDiagnostic): WalkResult {
  return { entries: [], blocks: [], diagnostics: [d] };
}

function innerText(blocks: readonly { readonly type: string }[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ────────── Prop narrowing ──────────
//
// Each declaration intrinsic's props arrive as `Record<string,
// unknown>`. The compiler-next helpers expect typed props — we
// narrow per intrinsic, mirroring the validation lenience of the
// existing block-mode props helpers in `props.ts` but with stronger
// typing because declarations have richer prop shapes.
//
// Standard-Schema validators and provider-options blobs flow through
// as-is (unknown → typed cast); the declaration helpers don't
// inspect their internals. Diagnostic emission catches the required-
// field misses; everything else is opaque pass-through.

function narrowToolProps(props: Readonly<Record<string, unknown>>): ToolProps {
  return {
    id: optString(props.id),
    name: optString(props.name),
    description: optString(props.description),
    inputSchema: props.inputSchema as ToolProps["inputSchema"],
    outputSchema: props.outputSchema as ToolProps["outputSchema"],
    exposure: props.exposure as readonly ToolExposure[] | undefined,
    handlerRef: optString(props.handlerRef),
    annotations: props.annotations as ToolAnnotations | undefined,
    metadata: props.metadata as Record<string, unknown> | undefined,
  };
}

function narrowMcpProps(props: Readonly<Record<string, unknown>>): McpProps {
  return {
    id: optString(props.id),
    serverName: optString(props.serverName),
    transport: props.transport as MCPTransport | undefined,
    config: props.config as Record<string, unknown> | undefined,
    exposes: props.exposes as readonly ("tools" | "resources" | "prompts")[] | undefined,
    metadata: props.metadata as Record<string, unknown> | undefined,
  };
}

function narrowResourceProps(props: Readonly<Record<string, unknown>>): ResourceProps {
  return {
    id: optString(props.id),
    uri: optString(props.uri),
    name: optString(props.name),
    description: optString(props.description),
    mimeType: optString(props.mimeType),
    handlerRef: optString(props.handlerRef),
    metadata: props.metadata as Record<string, unknown> | undefined,
  };
}

function narrowOutputProps(props: Readonly<Record<string, unknown>>): OutputProps {
  return {
    id: optString(props.id),
    schema: props.schema as OutputProps["schema"],
    mode: props.mode as OutputDeclaration["mode"] | undefined,
    metadata: props.metadata as Record<string, unknown> | undefined,
  };
}

function narrowModelProps(props: Readonly<Record<string, unknown>>): ModelProps {
  return {
    id: optString(props.id),
    ref: optString(props.ref),
    responseFormat: props.responseFormat as ResponseFormat | undefined,
    maxOutputTokens: typeof props.maxOutputTokens === "number" ? props.maxOutputTokens : undefined,
    temperature: typeof props.temperature === "number" ? props.temperature : undefined,
    metadata: props.metadata as Record<string, unknown> | undefined,
    providerOptions: props.providerOptions as ModelProps["providerOptions"],
  };
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
