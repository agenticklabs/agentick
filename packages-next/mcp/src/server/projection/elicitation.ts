/**
 * Server→client elicitation routing.
 *
 * Tool handlers running in the server process can call
 * `ctx.elicit.text("Are you sure?")` / `.confirm(...)` / `.select(...)` etc.
 * Each call constructs a single form-mode `elicitation/create` JSON-RPC
 * request, sends it through the per-connection SDK `Server` via
 * `sdkServer.request(...)`, and maps the client's three-action response
 * (`accept` / `decline` / `cancel`) into either the typed value
 * (throwing-variant methods) or a {@link ElicitOutcome} discriminated
 * union (`try*` — landing with #171d.2.2).
 *
 * Scope of this slice (#171d.2.1):
 *   - Form-mode basics: `text`, `confirm`, `boolean`, `number`,
 *     `select`, `multiSelect`.
 *   - Throwing semantics on decline/cancel (`ElicitationDeclined`,
 *     `ElicitationCancelled` — temporary classes in this module; will
 *     migrate to `AgentickError` subclasses in `spec-next/errors`
 *     during #171d.2.2).
 *   - Capability probe (`canDoForm`) reads `clientCapabilities`
 *     advertised at `initialize`.
 *
 * Deferred to #171d.2.2 / d.2.3:
 *   - URL mode (`url`, `requireUrls`).
 *   - `try*` variants returning `ElicitOutcome`.
 *   - Schema-flatness validation, custom `object` shapes.
 *   - Per-call `timeoutMs` enforcement (server-side cancellation).
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Elicit, ElicitTimeoutOption } from "@agentick/spec-next";

// ============================================================================
// Errors — temporary classes; migrate to AgentickError subclasses with #256
// follow-up during #171d.2.2.
// ============================================================================

export class ElicitationDeclined extends Error {
  override readonly name = "ElicitationDeclined";
  readonly reason?: string;
  constructor(message = "User declined the elicitation", reason?: string) {
    super(message);
    if (reason !== undefined) this.reason = reason;
  }
}

export class ElicitationCancelled extends Error {
  override readonly name = "ElicitationCancelled";
  readonly reason?: string;
  constructor(message = "User cancelled the elicitation", reason?: string) {
    super(message);
    if (reason !== undefined) this.reason = reason;
  }
}

export class ElicitationNotSupported extends Error {
  override readonly name = "ElicitationNotSupported";
  constructor() {
    super("Connected client did not advertise the `elicitation` capability");
  }
}

// ============================================================================
// Capability probe
// ============================================================================

export interface ElicitationCapabilities {
  readonly any: boolean;
  readonly form: boolean;
  readonly url: boolean;
}

/**
 * Inspect a client's negotiated capabilities for elicitation
 * sub-features. Per MCP spec 2025-11-25: an empty `elicitation: {}`
 * is treated as form-only for backwards compatibility with the older
 * capability shape; `elicitation: { form: {}, url: {} }` is explicit.
 */
export function inspectElicitationCapabilities(
  clientCapabilities: Readonly<Record<string, unknown>> | null | undefined,
): ElicitationCapabilities {
  const e = (clientCapabilities ?? {})["elicitation"];
  if (e == null || typeof e !== "object") {
    return { any: false, form: false, url: false };
  }
  const subCaps = e as { form?: unknown; url?: unknown };
  const explicitForm = subCaps.form !== undefined;
  const explicitUrl = subCaps.url !== undefined;
  // Empty `{}` → legacy shape → form-only.
  const legacy = !explicitForm && !explicitUrl;
  return {
    form: legacy || explicitForm,
    url: explicitUrl,
    any: legacy || explicitForm || explicitUrl,
  };
}

// ============================================================================
// Schema builders — flat JSON Schemas matching MCP elicitation/create
// ============================================================================

type FlatProperty = Readonly<Record<string, unknown>>;

function flatObjectSchema(properties: Readonly<Record<string, FlatProperty>>): FlatProperty {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function textProp(opts?: {
  default?: string;
  pattern?: string;
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
}): FlatProperty {
  const out: Record<string, unknown> = { type: "string" };
  if (opts?.default !== undefined) out["default"] = opts.default;
  if (opts?.pattern !== undefined) out["pattern"] = opts.pattern;
  if (opts?.format !== undefined) out["format"] = opts.format;
  if (opts?.minLength !== undefined) out["minLength"] = opts.minLength;
  if (opts?.maxLength !== undefined) out["maxLength"] = opts.maxLength;
  return out;
}

function numberProp(opts?: {
  min?: number;
  max?: number;
  integer?: boolean;
  default?: number;
}): FlatProperty {
  const out: Record<string, unknown> = { type: opts?.integer ? "integer" : "number" };
  if (opts?.min !== undefined) out["minimum"] = opts.min;
  if (opts?.max !== undefined) out["maximum"] = opts.max;
  if (opts?.default !== undefined) out["default"] = opts.default;
  return out;
}

function booleanProp(opts?: { default?: boolean }): FlatProperty {
  const out: Record<string, unknown> = { type: "boolean" };
  if (opts?.default !== undefined) out["default"] = opts.default;
  return out;
}

function enumProp<T extends readonly string[]>(
  options: T,
  opts?: { default?: T[number]; labels?: Partial<Record<T[number], string>> },
): FlatProperty {
  const out: Record<string, unknown> = { type: "string", enum: options };
  if (opts?.default !== undefined) out["default"] = opts.default;
  if (opts?.labels) out["enumNames"] = options.map((o) => opts.labels?.[o as T[number]] ?? o);
  return out;
}

function multiEnumProp<T extends readonly string[]>(
  options: T,
  opts?: {
    default?: ReadonlyArray<T[number]>;
    min?: number;
    max?: number;
    labels?: Partial<Record<T[number], string>>;
  },
): FlatProperty {
  const itemSchema = enumProp(options, opts?.labels ? { labels: opts.labels } : undefined);
  const out: Record<string, unknown> = { type: "array", items: itemSchema, uniqueItems: true };
  if (opts?.default !== undefined) out["default"] = opts.default;
  if (opts?.min !== undefined) out["minItems"] = opts.min;
  if (opts?.max !== undefined) out["maxItems"] = opts.max;
  return out;
}

// ============================================================================
// Routing — single form-mode request through sdkServer.request
// ============================================================================

/**
 * Single round-trip: build the `elicitation/create` request, send it
 * via the SDK Server, and return the result (parsed by
 * `ElicitResultSchema`). Throws if the round-trip itself fails
 * (transport, validation); does NOT throw on `decline`/`cancel`
 * outcomes — the caller maps those.
 */
async function sendElicit(
  sdkServer: SdkServer,
  message: string,
  schema: FlatProperty,
  _timeoutMs?: ElicitTimeoutOption,
): Promise<{
  action: "accept" | "decline" | "cancel";
  content?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}> {
  // The SDK's `request<T>` overload narrows by the result schema.
  const result = await sdkServer.request(
    { method: "elicitation/create", params: { message, requestedSchema: schema } },
    ElicitResultSchema,
  );
  return {
    action: result.action,
    ...(result.content !== undefined
      ? {
          content: result.content as Readonly<
            Record<string, string | number | boolean | readonly string[]>
          >,
        }
      : {}),
  };
}

/**
 * Map an `accept` content payload to a typed value by pulling the
 * single field identified by `key`. The MCP elicit shape always
 * returns a flat object; we pluck the one property our schema asked
 * for.
 */
function pluck<T>(content: Readonly<Record<string, unknown>> | undefined, key: string): T {
  if (content === undefined) {
    throw new Error(`elicit: client returned accept with no content`);
  }
  if (!(key in content)) {
    throw new Error(`elicit: client accept content missing expected key '${key}'`);
  }
  return content[key] as T;
}

// ============================================================================
// The factory — builds an Elicit instance scoped to one connection
// ============================================================================

export interface BuildMcpElicitOptions {
  readonly sdkServer: SdkServer;
  readonly clientCapabilities: Readonly<Record<string, unknown>> | null;
}

/**
 * Build a per-connection {@link Elicit} sugar instance. Wires the
 * methods to `sdkServer.request("elicitation/create")` so each call
 * round-trips to the connected MCP client.
 *
 * Every method THROWS on `decline` / `cancel`. The `try*` variants
 * (returning {@link ElicitOutcome}) land with #171d.2.2.
 *
 * Methods throw {@link ElicitationNotSupported} when the connected
 * client didn't advertise the `elicitation` capability — the
 * capability probe runs at construction time AND each call (the
 * latter is cheap and avoids surprise if capability state changes
 * mid-session, though SDK semantics make that unlikely).
 */
export function buildMcpElicit(options: BuildMcpElicitOptions): Elicit {
  const caps = inspectElicitationCapabilities(options.clientCapabilities);

  function ensureFormMode(): void {
    if (!caps.form) throw new ElicitationNotSupported();
  }

  async function singleField<T>(
    message: string,
    key: string,
    propSchema: FlatProperty,
    timeoutMs?: ElicitTimeoutOption,
  ): Promise<T> {
    ensureFormMode();
    const wrapped = flatObjectSchema({ [key]: propSchema });
    const result = await sendElicit(options.sdkServer, message, wrapped, timeoutMs);
    switch (result.action) {
      case "accept":
        return pluck<T>(result.content, key);
      case "decline":
        throw new ElicitationDeclined();
      case "cancel":
        throw new ElicitationCancelled();
    }
  }

  return {
    text(message, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleField<string>(message, "value", textProp(propOpts), timeoutMs);
    },

    select(message, choices, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleField<(typeof choices)[number]>(
        message,
        "value",
        enumProp(choices, propOpts),
        timeoutMs,
      );
    },

    multiSelect(message, choices, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleField<Array<(typeof choices)[number]>>(
        message,
        "value",
        multiEnumProp(choices, propOpts),
        timeoutMs,
      );
    },

    confirm(message, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleField<boolean>(message, "value", booleanProp(propOpts), timeoutMs);
    },

    boolean(message, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleField<boolean>(message, "value", booleanProp(propOpts), timeoutMs);
    },

    number(message, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleField<number>(message, "value", numberProp(propOpts), timeoutMs);
    },

    canDoForm() {
      return caps.form;
    },
  };
}
