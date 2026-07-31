/**
 * Server→client elicitation routing.
 *
 * Tool handlers running in the server process can call
 * `ctx.elicit.text("Are you sure?")` / `.confirm(...)` / `.select(...)` etc.
 * Each call constructs a single `elicitation/create` JSON-RPC request,
 * sends it through the per-connection SDK `Server` via
 * `sdkServer.request(...)`, and maps the client's three-action response
 * (`accept` / `decline` / `cancel`) into either:
 *
 *   - The typed value (throwing variants → throw
 *     `ElicitationDeclined` / `ElicitationCancelled` on those outcomes), OR
 *   - An {@link ElicitOutcome} discriminated union (`try*` variants).
 *
 * Coverage:
 *   - Form-mode (#171d.2.1): text, confirm, boolean, number, select,
 *     multiSelect.
 *   - URL mode (#171d.2.2): `url(spec)` — single URL consent;
 *     `requireUrls(specs)` — throws `UrlElicitationRequired` (-32042
 *     JSON-RPC) for the OAuth-style deferred-auth retry pattern.
 *   - `try*` variants for every throwing form-mode method + `tryUrl`.
 *
 * Deferred to #171d.2.3:
 *   - Schema-flatness validation, `object<T>(message, schema)` for
 *     Standard-Schema-driven custom shapes.
 *   - Per-call `timeoutMs` enforcement (server-side AbortController
 *     wiring).
 */

import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ElicitationCancelled,
  ElicitationDeclined,
  ElicitationNotSupported,
  UrlElicitationRequired,
  type Elicit,
  type ElicitOutcome,
  type ElicitTimeoutOption,
  type UrlElicitOutcome,
  type UrlElicitSpec,
  type UrlElicitationSpec,
} from "@agentick/spec";
import { ulid } from "@agentick/runtime";
import { omitUndefined } from "@agentick/utils";
// Shape vocabulary is shared with the in-process sugar so one question asked
// two ways describes itself identically. The MCP-specific parts stay here: the
// single-key `flatObjectSchema` wrapping `requestedSchema` demands, and
// `checkFlatSchema` for adopters bridging their own `elicitation/create`.
import {
  booleanProp,
  enumProp,
  flatObjectSchema,
  multiEnumProp,
  numberProp,
  textProp,
  type FlatProperty,
} from "@agentick/elicitation";

// Re-export the spec classes so adopters who catch these can stay on
// the `@agentick/mcp/server` import path.
export {
  ElicitationCancelled,
  ElicitationDeclined,
  ElicitationNotSupported,
  UrlElicitationRequired,
};

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
// Routing — single form-mode round-trip through sdkServer.request
// ============================================================================

interface FormRoundTripResult {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

async function sendFormElicit(
  sdkServer: SdkServer,
  message: string,
  schema: FlatProperty,
  _timeoutMs?: ElicitTimeoutOption,
): Promise<FormRoundTripResult> {
  const result = await sdkServer.request(
    { method: "elicitation/create", params: { message, requestedSchema: schema } },
    ElicitResultSchema,
  );
  return omitUndefined({
    action: result.action,
    content: result.content as Readonly<
      Record<string, string | number | boolean | readonly string[]>
    >,
  }) as FormRoundTripResult;
}

async function sendUrlElicit(
  sdkServer: SdkServer,
  spec: UrlElicitSpec,
  elicitationId: string,
  _timeoutMs?: ElicitTimeoutOption,
): Promise<UrlElicitOutcome> {
  // MCP draft URL-mode wire shape: `mode: "url"` + `url` + `elicitationId`.
  // The SDK's ElicitRequest type doesn't yet carry `mode` typed-strictly;
  // we pass via `params` directly with a cast at the boundary.
  const result = (await sdkServer.request(
    {
      method: "elicitation/create",
      params: {
        message: spec.message,
        mode: "url",
        url: spec.url,
        elicitationId,
        // The SDK still requires `requestedSchema`; URL mode uses an
        // empty object schema as a placeholder. The client SHOULD
        // ignore it on URL-mode requests.
        requestedSchema: flatObjectSchema({}),
      },
    } as Parameters<SdkServer["request"]>[0],
    ElicitResultSchema,
  )) as { action: "accept" | "decline" | "cancel" };

  return { status: result.action } as UrlElicitOutcome;
}

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

export function buildMcpElicit(options: BuildMcpElicitOptions): Elicit {
  const caps = inspectElicitationCapabilities(options.clientCapabilities);

  function ensureFormMode(): void {
    if (!caps.form) throw new ElicitationNotSupported({ mode: "form" });
  }
  function ensureUrlMode(): void {
    if (!caps.url) throw new ElicitationNotSupported({ mode: "url" });
  }

  async function singleField<T>(
    message: string,
    key: string,
    propSchema: FlatProperty,
    timeoutMs?: ElicitTimeoutOption,
  ): Promise<T> {
    ensureFormMode();
    const wrapped = flatObjectSchema({ [key]: propSchema });
    const result = await sendFormElicit(options.sdkServer, message, wrapped, timeoutMs);
    switch (result.action) {
      case "accept":
        return pluck<T>(result.content, key);
      case "decline":
        throw new ElicitationDeclined();
      case "cancel":
        throw new ElicitationCancelled();
    }
  }

  async function singleFieldTry<T>(
    message: string,
    key: string,
    propSchema: FlatProperty,
    timeoutMs?: ElicitTimeoutOption,
  ): Promise<ElicitOutcome<T>> {
    ensureFormMode();
    const wrapped = flatObjectSchema({ [key]: propSchema });
    const result = await sendFormElicit(options.sdkServer, message, wrapped, timeoutMs);
    if (result.action === "accept")
      return { status: "accept", value: pluck<T>(result.content, key) };
    return { status: result.action };
  }

  return {
    // ─────────── Form mode — throwing variants ───────────
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

    // ─────────── URL mode ───────────
    async url(spec) {
      ensureUrlMode();
      const elicitationId = `el-${ulid()}`;
      const outcome = await sendUrlElicit(options.sdkServer, spec, elicitationId, spec.timeoutMs);
      switch (outcome.status) {
        case "accept":
          return;
        case "decline":
          throw new ElicitationDeclined();
        case "cancel":
          throw new ElicitationCancelled();
      }
    },

    requireUrls(specs) {
      const elicitations: readonly UrlElicitationSpec[] = specs.map((spec) => ({
        mode: "url" as const,
        elicitationId: `el-required-${ulid()}`,
        url: spec.url,
        message: spec.message,
      }));
      throw new UrlElicitationRequired({ elicitations });
    },

    // ─────────── try* variants — non-throwing ───────────
    tryText(message, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleFieldTry<string>(message, "value", textProp(propOpts), timeoutMs);
    },
    trySelect(message, choices, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleFieldTry<(typeof choices)[number]>(
        message,
        "value",
        enumProp(choices, propOpts),
        timeoutMs,
      );
    },
    tryMultiSelect(message, choices, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleFieldTry<Array<(typeof choices)[number]>>(
        message,
        "value",
        multiEnumProp(choices, propOpts),
        timeoutMs,
      );
    },
    tryConfirm(message, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleFieldTry<boolean>(message, "value", booleanProp(propOpts), timeoutMs);
    },
    tryNumber(message, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleFieldTry<number>(message, "value", numberProp(propOpts), timeoutMs);
    },
    tryBoolean(message, opts) {
      const { timeoutMs, ...propOpts } = opts ?? {};
      return singleFieldTry<boolean>(message, "value", booleanProp(propOpts), timeoutMs);
    },
    async tryUrl(spec) {
      ensureUrlMode();
      const elicitationId = `el-${ulid()}`;
      return sendUrlElicit(options.sdkServer, spec, elicitationId, spec.timeoutMs);
    },

    // ─────────── Capability probes ───────────
    canDoForm() {
      return caps.form;
    },
    canDoUrl() {
      return caps.url;
    },
  };
}
