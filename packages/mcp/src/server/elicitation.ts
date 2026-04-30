/**
 * Elicitation — server-side outbound `elicitation/create` (form + URL
 * modes), the `ctx.elicit.*` sugar surface, schema-flatness validation,
 * and the `URLElicitationRequiredError` -32042 deferred-auth path.
 *
 * @module @agentick/mcp/server/elicitation
 */

import type { ZodType } from "zod";
import type {
  ElicitAPI,
  ElicitOutcome,
  ElicitationFormSchema,
  ElicitationPrimitiveSchema,
  ElicitationResponse,
  UrlElicitOutcome,
  UrlElicitationResponse,
} from "../protocol/types.js";
import { toJSONSchemaSync } from "@agentick/kernel";
import { protocolError } from "../protocol/errors.js";

// ============================================================================
// Errors
// ============================================================================

/** Thrown when the user explicitly declined an elicitation request. */
export class ElicitationDeclined extends Error {
  constructor(message = "User declined the elicitation") {
    super(message);
    this.name = "ElicitationDeclined";
  }
}

/** Thrown when the user dismissed the elicitation without deciding. */
export class ElicitationCancelled extends Error {
  constructor(message = "User cancelled the elicitation") {
    super(message);
    this.name = "ElicitationCancelled";
  }
}

/**
 * Thrown when the requested elicitation mode (form or url) is not
 * supported by the connected client (sub-cap missing).
 */
export class ElicitationModeNotSupported extends Error {
  readonly mode: "form" | "url";

  constructor(mode: "form" | "url") {
    super(`Client did not advertise the elicitation.${mode} sub-capability`);
    this.name = "ElicitationModeNotSupported";
    this.mode = mode;
  }
}

// ============================================================================
// Capability inspection
// ============================================================================

export interface ElicitationCapabilities {
  /** Any form of elicitation is advertised. */
  any: boolean;
  /** Form-mode is supported (or legacy empty `elicitation: {}`). */
  form: boolean;
  /** URL-mode is supported. */
  url: boolean;
}

/**
 * Inspect a client's negotiated capabilities for elicitation sub-features.
 *
 * Per spec 2025-11-25: `elicitation: {}` (empty object) is treated as
 * form-only for backwards compatibility with the older capability shape.
 * `elicitation: { form: {}, url: {} }` is the new explicit form.
 */
export function inspectElicitationCapabilities(
  clientCapabilities: Record<string, unknown> | undefined,
): ElicitationCapabilities {
  const root = (clientCapabilities ?? {}) as { elicitation?: unknown };
  const e = root.elicitation;
  if (e == null || typeof e !== "object") {
    return { any: false, form: false, url: false };
  }
  const sub = e as Record<string, unknown>;
  // Legacy: empty object means form-only
  if (Object.keys(sub).length === 0) {
    return { any: true, form: true, url: false };
  }
  const form = sub.form != null && typeof sub.form === "object";
  const url = sub.url != null && typeof sub.url === "object";
  return { any: form || url, form, url };
}

// ============================================================================
// Internal source — owned by MCPServer
// ============================================================================

export interface ElicitationSource {
  /**
   * Form-mode primitive — issues `elicitation/create` with a JSON Schema
   * and resolves with the user's response.
   */
  request(params: {
    message: string;
    requestedSchema: ElicitationFormSchema;
  }): Promise<ElicitationResponse>;

  /** URL-mode primitive — issues `elicitation/create` with `mode: "url"`. */
  requestUrl(params: {
    message: string;
    url: string;
    elicitationId: string;
  }): Promise<UrlElicitationResponse>;

  capabilities: ElicitationCapabilities;
}

// ============================================================================
// Schema flatness validation
// ============================================================================

/**
 * Walk a JSON Schema produced from a Zod object and verify it conforms
 * to the spec's "flat object with primitive properties" rule. Returns
 * an array of validation messages (empty on success).
 *
 * Allowed at the property level:
 * - `string`, `number`, `integer`, `boolean` primitives
 * - String enum (single-select)
 * - `array` whose `items.type === "string"` (with optional enum)
 *
 * Disallowed:
 * - Nested `object` types
 * - `array` of non-primitive items
 * - Discriminated unions, intersections, anyOf at the property level
 *   (other than the spec-defined oneOf+const+title labeled-enum form)
 */
export function validateFormSchemaFlatness(schema: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (schema.type !== "object") {
    issues.push(`top-level schema must be type:"object", got ${String(schema.type)}`);
  }
  const properties = (schema.properties as Record<string, unknown>) ?? {};
  if (typeof properties !== "object") {
    issues.push("schema.properties must be an object");
    return issues;
  }
  for (const [key, prop] of Object.entries(properties)) {
    if (typeof prop !== "object" || prop === null) {
      issues.push(`property '${key}' is not a valid schema`);
      continue;
    }
    const p = prop as Record<string, unknown>;
    const t = p.type;

    // Single-select enum (untitled or titled via oneOf+const+title)
    if (t === "string") continue;
    if (t === "number" || t === "integer") continue;
    if (t === "boolean") continue;

    if (t === "array") {
      // Multi-select — per spec, items MUST be either:
      //   - { type: "string", enum: [...] } (untitled multi-select), or
      //   - { anyOf: [{ const, title }, ...] } (titled multi-select).
      // Free-form `z.array(z.string())` (items: { type: "string" } without enum)
      // is intentionally not supported — the spec restricts multi-select arrays
      // to enumerated options.
      const items = p.items as Record<string, unknown> | undefined;
      if (!items || typeof items !== "object") {
        issues.push(`property '${key}': array items missing or invalid`);
        continue;
      }
      const hasEnum = items.type === "string" && Array.isArray(items.enum);
      const hasAnyOf = Array.isArray(items.anyOf);
      if (hasEnum || hasAnyOf) continue;
      issues.push(
        `property '${key}': array items must enumerate options ` +
          `(items.enum or items.anyOf with const+title) — free-form string arrays are not allowed in form-mode schemas`,
      );
      continue;
    }

    if (t === "object") {
      issues.push(`property '${key}': nested objects are not allowed in form-mode schemas`);
      continue;
    }

    // Anything else → reject
    issues.push(`property '${key}': unsupported type '${String(t)}'`);
  }
  return issues;
}

// ============================================================================
// ElicitAPI implementation
// ============================================================================

/** Internal — sugar wraps a single property named `value`. */
const VALUE_KEY = "value";

function buildSingleValueSchema(prop: ElicitationPrimitiveSchema): ElicitationFormSchema {
  return {
    type: "object",
    properties: { [VALUE_KEY]: prop },
    required: [VALUE_KEY],
  };
}

function unwrapSingleValue<T>(content: Record<string, unknown> | undefined): T {
  return content?.[VALUE_KEY] as T as T;
}

/** Throw the appropriate typed error for non-accept actions. */
function throwForAction(action: "decline" | "cancel"): never {
  if (action === "decline") throw new ElicitationDeclined();
  throw new ElicitationCancelled();
}

export class ElicitAPIImpl implements ElicitAPI {
  constructor(private readonly source: ElicitationSource) {}

  // ── Capability probes ──────────────────────────────────────────────

  canDoForm(): boolean {
    return this.source.capabilities.form;
  }
  canDoUrl(): boolean {
    return this.source.capabilities.url;
  }

  // ── Internal: form-mode dispatch ──────────────────────────────────

  private async dispatchForm(
    message: string,
    requestedSchema: ElicitationFormSchema,
  ): Promise<ElicitationResponse> {
    if (!this.source.capabilities.form) {
      throw new ElicitationModeNotSupported("form");
    }
    return this.source.request({ message, requestedSchema });
  }

  // ── text ───────────────────────────────────────────────────────────

  async text(message: string, opts: Parameters<ElicitAPI["text"]>[1] = {}): Promise<string> {
    const result = await this.dispatchForm(
      message,
      buildSingleValueSchema(this.buildStringSchema(opts)),
    );
    if (result.action === "accept") return unwrapSingleValue<string>(result.content);
    throwForAction(result.action);
  }

  async tryText(
    message: string,
    opts: Parameters<ElicitAPI["text"]>[1] = {},
  ): Promise<ElicitOutcome<string>> {
    const result = await this.dispatchForm(
      message,
      buildSingleValueSchema(this.buildStringSchema(opts)),
    );
    if (result.action === "accept") {
      return { status: "accept", value: unwrapSingleValue<string>(result.content) };
    }
    return { status: result.action };
  }

  private buildStringSchema(
    opts: Parameters<ElicitAPI["text"]>[1] = {},
  ): ElicitationPrimitiveSchema {
    const s: Record<string, unknown> = { type: "string" };
    if (opts.default !== undefined) s.default = opts.default;
    if (opts.format) s.format = opts.format;
    if (opts.minLength !== undefined) s.minLength = opts.minLength;
    if (opts.maxLength !== undefined) s.maxLength = opts.maxLength;
    // pattern is not in the spec's primitive schema — skip silently
    return s as ElicitationPrimitiveSchema;
  }

  // ── select ─────────────────────────────────────────────────────────

  private buildSelectSchema(
    options: readonly string[],
    opts: { default?: string; labels?: Record<string, string> } = {},
  ): ElicitationPrimitiveSchema {
    if (opts.labels && Object.keys(opts.labels).length > 0) {
      // Titled (oneOf+const+title)
      const oneOf = options.map((value) => ({
        const: value,
        title: opts.labels?.[value] ?? value,
      }));
      const s: Record<string, unknown> = { type: "string", oneOf };
      if (opts.default !== undefined) s.default = opts.default;
      return s as ElicitationPrimitiveSchema;
    }
    // Plain enum
    const s: Record<string, unknown> = { type: "string", enum: [...options] };
    if (opts.default !== undefined) s.default = opts.default;
    return s as ElicitationPrimitiveSchema;
  }

  async select<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: { default?: T[number]; labels?: Partial<Record<T[number], string>> },
  ): Promise<T[number]> {
    const schema = this.buildSelectSchema(
      options,
      opts as { default?: string; labels?: Record<string, string> },
    );
    const result = await this.dispatchForm(message, buildSingleValueSchema(schema));
    if (result.action === "accept") return unwrapSingleValue<T[number]>(result.content);
    throwForAction(result.action);
  }

  async trySelect<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: { default?: T[number]; labels?: Partial<Record<T[number], string>> },
  ): Promise<ElicitOutcome<T[number]>> {
    const schema = this.buildSelectSchema(
      options,
      opts as { default?: string; labels?: Record<string, string> },
    );
    const result = await this.dispatchForm(message, buildSingleValueSchema(schema));
    if (result.action === "accept") {
      return { status: "accept", value: unwrapSingleValue<T[number]>(result.content) };
    }
    return { status: result.action };
  }

  // ── multiSelect ────────────────────────────────────────────────────

  private buildMultiSelectSchema(
    options: readonly string[],
    opts: {
      default?: string[];
      min?: number;
      max?: number;
      labels?: Record<string, string>;
    } = {},
  ): ElicitationPrimitiveSchema {
    if (opts.min !== undefined && opts.max !== undefined && opts.min > opts.max) {
      throw new Error(`multiSelect: min (${opts.min}) cannot exceed max (${opts.max})`);
    }
    const items = opts.labels
      ? {
          anyOf: options.map((value) => ({
            const: value,
            title: opts.labels?.[value] ?? value,
          })),
        }
      : { type: "string" as const, enum: [...options] };
    const s: Record<string, unknown> = { type: "array", items };
    if (opts.min !== undefined) s.minItems = opts.min;
    if (opts.max !== undefined) s.maxItems = opts.max;
    if (opts.default !== undefined) s.default = opts.default;
    return s as ElicitationPrimitiveSchema;
  }

  async multiSelect<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: Parameters<ElicitAPI["multiSelect"]>[2],
  ): Promise<Array<T[number]>> {
    const schema = this.buildMultiSelectSchema(
      options,
      opts as {
        default?: string[];
        min?: number;
        max?: number;
        labels?: Record<string, string>;
      },
    );
    const result = await this.dispatchForm(message, buildSingleValueSchema(schema));
    if (result.action === "accept") return unwrapSingleValue<Array<T[number]>>(result.content);
    throwForAction(result.action);
  }

  async tryMultiSelect<const T extends readonly string[]>(
    message: string,
    options: T,
    opts?: Parameters<ElicitAPI["multiSelect"]>[2],
  ): Promise<ElicitOutcome<Array<T[number]>>> {
    const schema = this.buildMultiSelectSchema(
      options,
      opts as {
        default?: string[];
        min?: number;
        max?: number;
        labels?: Record<string, string>;
      },
    );
    const result = await this.dispatchForm(message, buildSingleValueSchema(schema));
    if (result.action === "accept") {
      return {
        status: "accept",
        value: unwrapSingleValue<Array<T[number]>>(result.content),
      };
    }
    return { status: result.action };
  }

  // ── confirm ────────────────────────────────────────────────────────

  async confirm(message: string, opts: { default?: boolean } = {}): Promise<boolean> {
    const schema: Record<string, unknown> = { type: "boolean" };
    if (opts.default !== undefined) schema.default = opts.default;
    const result = await this.dispatchForm(
      message,
      buildSingleValueSchema(schema as ElicitationPrimitiveSchema),
    );
    if (result.action === "accept") return unwrapSingleValue<boolean>(result.content);
    throwForAction(result.action);
  }

  async tryConfirm(
    message: string,
    opts: { default?: boolean } = {},
  ): Promise<ElicitOutcome<boolean>> {
    const schema: Record<string, unknown> = { type: "boolean" };
    if (opts.default !== undefined) schema.default = opts.default;
    const result = await this.dispatchForm(
      message,
      buildSingleValueSchema(schema as ElicitationPrimitiveSchema),
    );
    if (result.action === "accept") {
      return { status: "accept", value: unwrapSingleValue<boolean>(result.content) };
    }
    return { status: result.action };
  }

  // ── number ─────────────────────────────────────────────────────────

  private buildNumberSchema(
    opts: Parameters<ElicitAPI["number"]>[1] = {},
  ): ElicitationPrimitiveSchema {
    if (opts.min !== undefined && opts.max !== undefined && opts.min > opts.max) {
      throw new Error(`number: min (${opts.min}) cannot exceed max (${opts.max})`);
    }
    const s: Record<string, unknown> = { type: opts.integer ? "integer" : "number" };
    if (opts.min !== undefined) s.minimum = opts.min;
    if (opts.max !== undefined) s.maximum = opts.max;
    if (opts.default !== undefined) s.default = opts.default;
    return s as ElicitationPrimitiveSchema;
  }

  async number(message: string, opts?: Parameters<ElicitAPI["number"]>[1]): Promise<number> {
    const schema = this.buildNumberSchema(opts);
    const result = await this.dispatchForm(message, buildSingleValueSchema(schema));
    if (result.action === "accept") return unwrapSingleValue<number>(result.content);
    throwForAction(result.action);
  }

  async tryNumber(
    message: string,
    opts?: Parameters<ElicitAPI["number"]>[1],
  ): Promise<ElicitOutcome<number>> {
    const schema = this.buildNumberSchema(opts);
    const result = await this.dispatchForm(message, buildSingleValueSchema(schema));
    if (result.action === "accept") {
      return { status: "accept", value: unwrapSingleValue<number>(result.content) };
    }
    return { status: result.action };
  }

  // ── object — Zod schema input with flatness validation ────────────

  private buildObjectSchema<T>(schema: ZodType<T>): ElicitationFormSchema {
    const json = toJSONSchemaSync(schema, { target: "draft-2020-12", stripMeta: false });
    const issues = validateFormSchemaFlatness(json);
    if (issues.length > 0) {
      throw new Error(`elicit.object: schema is not flat per MCP spec — ${issues.join("; ")}`);
    }
    return json as unknown as ElicitationFormSchema;
  }

  async object<T>(message: string, schema: ZodType<T>): Promise<T> {
    const formSchema = this.buildObjectSchema(schema);
    const result = await this.dispatchForm(message, formSchema);
    if (result.action === "accept") return result.content as unknown as T;
    throwForAction(result.action);
  }

  async tryObject<T>(message: string, schema: ZodType<T>): Promise<ElicitOutcome<T>> {
    const formSchema = this.buildObjectSchema(schema);
    const result = await this.dispatchForm(message, formSchema);
    if (result.action === "accept") {
      return { status: "accept", value: result.content as unknown as T };
    }
    return { status: result.action };
  }

  // ── url ────────────────────────────────────────────────────────────

  async url(opts: { message: string; url: string }): Promise<UrlElicitOutcome> {
    if (!this.source.capabilities.url) {
      throw new ElicitationModeNotSupported("url");
    }
    const elicitationId = `el-${Math.random().toString(36).slice(2, 12)}`;
    const result = await this.source.requestUrl({
      message: opts.message,
      url: opts.url,
      elicitationId,
    });
    return { status: result.action } as UrlElicitOutcome;
  }

  async tryUrl(opts: { message: string; url: string }): Promise<UrlElicitOutcome> {
    return this.url(opts);
  }

  // ── requireUrls — deferred-auth protocol error ────────────────────

  requireUrls(elicitations: Array<{ message: string; url: string }>): never {
    // Throws a `URLElicitationRequiredError` — the SDK identifies this
    // by error code `-32042` and reconstructs it on the client side via
    // `error.data.elicitations`. Our server-side path uses
    // `protocolError(-32042, ...)` to avoid the SDK's McpError
    // double-prefix bug and ship a clean structured error.
    const data = {
      elicitations: elicitations.map((e, idx) => ({
        mode: "url" as const,
        elicitationId: `el-required-${idx}-${Math.random().toString(36).slice(2, 8)}`,
        url: e.url,
        message: e.message,
      })),
    };
    protocolError(-32042, "URL elicitation required", data);
  }
}
