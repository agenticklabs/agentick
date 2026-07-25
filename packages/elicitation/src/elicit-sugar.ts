/**
 * `buildSessionElicit(harness)` — wraps an in-process
 * `ElicitationHarness` in the {@link Elicit} sugar surface.
 *
 * In-process counterpart to `buildMcpElicit` in
 * `@agentick/mcp/server/projection/elicitation.ts`. Same `Elicit`
 * interface; different transport underneath. Tool handlers receive
 * the same surface regardless of which factory produced their ctx.
 *
 * Coverage parity with the MCP-server sugar:
 *   - Form mode: text, confirm, boolean, number, select, multiSelect.
 *   - URL mode: url, tryUrl.
 *   - Deferred-auth: requireUrls → throws `UrlElicitationRequired`.
 *   - try* variants for every throwing form-mode method.
 *   - canDoForm / canDoUrl capability probes (always true for the
 *     in-process harness, which supports both natively).
 *
 * @see ../docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md
 */

import type {
  Elicit,
  ElicitFn,
  ElicitOutcome,
  ElicitTimeoutOption,
  ElicitationHarnessProtocol,
  ElicitationResult,
  StandardSchemaV1,
  UrlElicitOutcome,
  UrlElicitSpec,
  UrlElicitationSpec,
} from "@agentick/spec";
import { ElicitationCancelled, ElicitationDeclined, UrlElicitationRequired } from "@agentick/spec";
import { ulid } from "@agentick/runtime";

// ============================================================================
// Inline Standard-Schema validators — primitives only
// ============================================================================
//
// The harness validates the client's reply against the request's
// schema before resolving. For the sugar surface we need
// Standard-Schema validators sized for the primitives we send.
// Kept inline to avoid pulling in a third-party schema library.

interface Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<string | number>;
}

function standardSchema<T>(
  vendor: string,
  validate: (value: unknown) => { readonly value: T } | { readonly issues: readonly Issue[] },
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate,
    },
  } as StandardSchemaV1<unknown, T>;
}

type Validator<T> = (raw: unknown) => { readonly value: T } | { readonly issues: readonly Issue[] };

function stringSchema(opts?: {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: "email" | "uri" | "date" | "date-time";
}): StandardSchemaV1<unknown, string> {
  const validate: Validator<string> = (raw) => {
    if (typeof raw !== "string") {
      return { issues: [{ message: `expected string, got ${typeof raw}` }] };
    }
    if (opts?.minLength !== undefined && raw.length < opts.minLength) {
      return { issues: [{ message: `string shorter than ${opts.minLength}` }] };
    }
    if (opts?.maxLength !== undefined && raw.length > opts.maxLength) {
      return { issues: [{ message: `string longer than ${opts.maxLength}` }] };
    }
    if (opts?.pattern !== undefined && !new RegExp(opts.pattern).test(raw)) {
      return { issues: [{ message: `string does not match pattern ${opts.pattern}` }] };
    }
    return { value: raw };
  };
  return standardSchema<string>("agentick:elicit:string", validate);
}

function numberSchema(opts?: {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}): StandardSchemaV1<unknown, number> {
  const validate: Validator<number> = (raw) => {
    if (typeof raw !== "number" || Number.isNaN(raw)) {
      return { issues: [{ message: `expected number, got ${typeof raw}` }] };
    }
    if (opts?.integer && !Number.isInteger(raw)) {
      return { issues: [{ message: `expected integer, got ${raw}` }] };
    }
    if (opts?.min !== undefined && raw < opts.min) {
      return { issues: [{ message: `number below minimum ${opts.min}` }] };
    }
    if (opts?.max !== undefined && raw > opts.max) {
      return { issues: [{ message: `number above maximum ${opts.max}` }] };
    }
    return { value: raw };
  };
  return standardSchema<number>("agentick:elicit:number", validate);
}

function booleanSchema(): StandardSchemaV1<unknown, boolean> {
  const validate: Validator<boolean> = (raw) => {
    if (typeof raw !== "boolean") {
      return { issues: [{ message: `expected boolean, got ${typeof raw}` }] };
    }
    return { value: raw };
  };
  return standardSchema<boolean>("agentick:elicit:boolean", validate);
}

function enumSchema<T extends readonly string[]>(options: T): StandardSchemaV1<unknown, T[number]> {
  const validate: Validator<T[number]> = (raw) => {
    if (typeof raw !== "string" || !(options as readonly string[]).includes(raw)) {
      return { issues: [{ message: `expected one of ${options.join("|")}, got ${String(raw)}` }] };
    }
    return { value: raw as T[number] };
  };
  return standardSchema<T[number]>("agentick:elicit:enum", validate);
}

function multiEnumSchema<T extends readonly string[]>(
  options: T,
  opts?: { readonly min?: number; readonly max?: number },
): StandardSchemaV1<unknown, Array<T[number]>> {
  const member = options as readonly string[];
  const validate = (
    raw: unknown,
  ): { readonly value: Array<T[number]> } | { readonly issues: readonly Issue[] } => {
    if (!Array.isArray(raw)) {
      return { issues: [{ message: `expected array, got ${typeof raw}` }] };
    }
    if (opts?.min !== undefined && raw.length < opts.min) {
      return { issues: [{ message: `array shorter than min ${opts.min}` }] };
    }
    if (opts?.max !== undefined && raw.length > opts.max) {
      return { issues: [{ message: `array longer than max ${opts.max}` }] };
    }
    for (const [i, v] of raw.entries()) {
      if (typeof v !== "string" || !member.includes(v)) {
        return { issues: [{ message: `item not one of ${options.join("|")}`, path: [i] }] };
      }
    }
    return { value: raw as Array<T[number]> };
  };
  return standardSchema<Array<T[number]>>("agentick:elicit:multi-enum", validate);
}

// ============================================================================
// Result mapping — translate ElicitationResult into throwing or outcome
// ============================================================================

function unwrapAccept<T>(result: ElicitationResult<T>): T {
  switch (result.outcome) {
    case "accepted":
      return result.value;
    case "declined":
      throw new ElicitationDeclined(
        result.reason !== undefined ? { reason: result.reason } : undefined,
      );
    case "cancelled":
      throw new ElicitationCancelled(
        result.reason !== undefined ? { reason: result.reason } : undefined,
      );
    case "failed":
      throw new Error(
        `elicit failed (${result.failure.kind}): ${result.failure.reason ?? "no reason"}`,
      );
  }
}

function asOutcome<T>(result: ElicitationResult<T>): ElicitOutcome<T> {
  switch (result.outcome) {
    case "accepted":
      return { status: "accept", value: result.value };
    case "declined":
      return result.reason !== undefined
        ? { status: "decline", reason: result.reason }
        : { status: "decline" };
    case "cancelled":
      return result.reason !== undefined
        ? { status: "cancel", reason: result.reason }
        : { status: "cancel" };
    case "failed":
      throw new Error(
        `elicit failed (${result.failure.kind}): ${result.failure.reason ?? "no reason"}`,
      );
  }
}

function asUrlOutcome(result: ElicitationResult<undefined>): UrlElicitOutcome {
  switch (result.outcome) {
    case "accepted":
      return { status: "accept" };
    case "declined":
      return result.reason !== undefined
        ? { status: "decline", reason: result.reason }
        : { status: "decline" };
    case "cancelled":
      return result.reason !== undefined
        ? { status: "cancel", reason: result.reason }
        : { status: "cancel" };
    case "failed":
      throw new Error(
        `elicit failed (${result.failure.kind}): ${result.failure.reason ?? "no reason"}`,
      );
  }
}

function timeoutOptToMs(opt: ElicitTimeoutOption | undefined): number | undefined {
  if (opt === undefined) return undefined;
  if (opt === "never") return undefined; // harness uses its own default; "never" semantics deferred
  return opt;
}

// ============================================================================
// Factory
// ============================================================================

export interface BuildSessionElicitOptions {
  readonly harness: ElicitationHarnessProtocol;
}

/**
 * Build a session-scoped {@link Elicit} sugar instance backed by an
 * in-process {@link ElicitationHarnessProtocol}. Tool handlers reach
 * it via `ctx.elicit.text(...)` etc., identical to the MCP-server
 * `ctx.elicit` surface — the same {@link Elicit} interface, the same
 * outcomes, the same throwing semantics on decline/cancel.
 *
 * Thin wrapper over {@link buildElicitSugar} whose {@link ElicitFn}
 * routes straight to the live harness (direct-to-client on a tick).
 */
export function buildSessionElicit(options: BuildSessionElicitOptions): Elicit {
  const { harness } = options;
  return buildElicitSugar((request, opts) =>
    // Branch so overload resolution picks the form / url signature — the
    // union arg alone won't resolve an overloaded call.
    request.mode === "url" ? harness.elicit(request, opts) : harness.elicit(request, opts),
  );
}

/**
 * Build the {@link Elicit} sugar surface over a raw {@link ElicitFn}
 * (ADR 69). This is the transport-agnostic core: every sugar method
 * (`text`, `confirm`, `select`, `url`, the `try*` variants, …)
 * constructs a flat-schema request and funnels through the single
 * `elicit` call. WHERE that call goes is the caller's concern:
 *
 *   - {@link buildSessionElicit} routes it to a live in-process harness
 *     (direct-to-client during a tick).
 *   - The tasks package (ADR 69) hands in an escalation-backed `ElicitFn`
 *     that wraps `awaitingInput` + `inbox.ask` up the ownership chain —
 *     so it reuses this exact sugar WITHOUT a dep on this package (the
 *     factory is injected as a `TaskElicitFactory`).
 *
 * @see docs/proposals/v2/blueprint/69-request-escalation.md
 */
export function buildElicitSugar(elicit: ElicitFn): Elicit {
  async function form<T>(
    message: string,
    schema: StandardSchemaV1<unknown, T>,
    timeoutMs?: ElicitTimeoutOption,
  ): Promise<ElicitationResult<T>> {
    const ms = timeoutOptToMs(timeoutMs);
    const opts = ms !== undefined ? { timeoutMs: ms } : undefined;
    return (await elicit({ mode: "form", message, schema }, opts)) as ElicitationResult<T>;
  }

  async function sendUrl(
    spec: UrlElicitSpec,
    elicitationId: string,
  ): Promise<ElicitationResult<undefined>> {
    const ms = timeoutOptToMs(spec.timeoutMs);
    const opts = ms !== undefined ? { timeoutMs: ms } : undefined;
    return (await elicit(
      { mode: "url", message: spec.message, url: spec.url, elicitationId },
      opts,
    )) as ElicitationResult<undefined>;
  }

  return {
    // ─────────── Form mode — throwing variants ───────────
    async text(message, opts) {
      const schema = stringSchema(opts);
      return unwrapAccept(await form(message, schema, opts?.timeoutMs));
    },
    async select(message, choices, opts) {
      const schema = enumSchema(choices);
      return unwrapAccept(await form(message, schema, opts?.timeoutMs));
    },
    async multiSelect(message, choices, opts) {
      const schema = multiEnumSchema(choices, opts);
      return unwrapAccept(await form(message, schema, opts?.timeoutMs));
    },
    async confirm(message, opts) {
      const schema = booleanSchema();
      return unwrapAccept(await form(message, schema, opts?.timeoutMs));
    },
    async boolean(message, opts) {
      const schema = booleanSchema();
      return unwrapAccept(await form(message, schema, opts?.timeoutMs));
    },
    async number(message, opts) {
      const schema = numberSchema(opts);
      return unwrapAccept(await form(message, schema, opts?.timeoutMs));
    },

    // ─────────── URL mode ───────────
    async url(spec) {
      const elicitationId = `el-${ulid()}`;
      const result = await sendUrl(spec, elicitationId);
      const outcome = asUrlOutcome(result);
      switch (outcome.status) {
        case "accept":
          return;
        case "decline":
          throw new ElicitationDeclined(
            outcome.reason !== undefined ? { reason: outcome.reason } : undefined,
          );
        case "cancel":
          throw new ElicitationCancelled(
            outcome.reason !== undefined ? { reason: outcome.reason } : undefined,
          );
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
    async tryText(message, opts) {
      return asOutcome(await form(message, stringSchema(opts), opts?.timeoutMs));
    },
    async trySelect(message, choices, opts) {
      return asOutcome(await form(message, enumSchema(choices), opts?.timeoutMs));
    },
    async tryMultiSelect(message, choices, opts) {
      return asOutcome(await form(message, multiEnumSchema(choices, opts), opts?.timeoutMs));
    },
    async tryConfirm(message, opts) {
      return asOutcome(await form(message, booleanSchema(), opts?.timeoutMs));
    },
    async tryNumber(message, opts) {
      return asOutcome(await form(message, numberSchema(opts), opts?.timeoutMs));
    },
    async tryBoolean(message, opts) {
      return asOutcome(await form(message, booleanSchema(), opts?.timeoutMs));
    },
    async tryUrl(spec) {
      const elicitationId = `el-${ulid()}`;
      return asUrlOutcome(await sendUrl(spec, elicitationId));
    },

    // ─────────── Capability probes ───────────
    canDoForm() {
      // In-process harness always supports form mode — the protocol
      // is the canonical form-mode implementation. URL mode too.
      return true;
    },
    canDoUrl() {
      return true;
    },
  };
}
