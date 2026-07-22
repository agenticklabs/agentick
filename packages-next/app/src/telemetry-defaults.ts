/**
 * Telemetry enrichment defaults (telemetry rung 1) — the composition the
 * `createApp({ telemetry })` switch registers when enrichment is ON.
 *
 * This module is PURE SUGAR over rungs 2–3: it builds a list of Effect-native
 * {@link Middleware} from the rung-3 helpers ({@link spanAttributes},
 * {@link annotateOperationSpan}) plus the pricing module. There is NO bespoke
 * telemetry machinery here — every interceptor annotates the ambient operation
 * span that `runOperation` already opened (ADR 78). The list is threaded onto
 * the session's tier-4 `withCallMiddleware` seam (the same seam rung 2 rides),
 * so it reaches EVERY op a send touches — ticks, model calls, tool dispatches —
 * across construction-siblings and per-tick-swapped executors alike. When the
 * switch is off the list is never built (zero overhead).
 *
 * Attribute-key naming (Ryan's rule): keys are DOT-separated, never colon
 * (colons live only in span/op NAMES). Two tiers:
 *   1. Where the OTel GenAI semantic conventions define a key, use it VERBATIM
 *      (`gen_ai.request.model`, `gen_ai.system`, `gen_ai.usage.input_tokens`,
 *      `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reason`) — vendor
 *      LLM dashboards auto-recognize these. `service.name` is likewise the
 *      standard OTel resource key. These are NOT whitelabeled.
 *   2. Framework-specific keys under the whitelabelable `<ns>.*` namespace
 *      (`agentick.app.name`, `agentick.function.id`, `agentick.tool.name`,
 *      `agentick.tick.index`, `agentick.usage.cost_usd`).
 * Every bag is an open `Record<string, unknown>` — a new dimension is a new
 * key, never a framework change. Adopter `attributes` keys are stamped verbatim
 * (their namespace, we don't police it).
 *
 * @see docs/proposals/v2/blueprint/78-telemetry-via-runtime-substrate.md
 */

import { Effect, Layer } from "effect";
import {
  annotateOperationSpan,
  deriveHookNames,
  getContext,
  spanAttributes,
  type Middleware,
} from "@agentick/runtime-next";
import { estimateCost } from "@agentick/model-next";
import type {
  ExecutionTarget,
  TelemetryLayer,
  TelemetryOptions,
  TelemetrySetting,
  UsageStats,
} from "@agentick/spec-next";

/** Normalized form of the {@link TelemetrySetting} switch (rung 1). */
export interface NormalizedTelemetry {
  /** Enrichment on (any truthy setting). Off → no interceptors, zero overhead. */
  readonly enabled: boolean;
  /** Exporter Layer (raw-Layer form, or the config's `layer`). Undefined → no runtime. */
  readonly layer?: TelemetryLayer;
  readonly serviceName?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/**
 * Normalize the STRICTLY-OPT-IN {@link TelemetrySetting} into its enrichment
 * flag + exporter Layer + config. `undefined` / `false` → off. `true` → on, no
 * exporter. A `Layer` (detected via `Layer.isLayer`) → on + that exporter. A
 * `{ serviceName?, attributes?, layer? }` object → on + its fields.
 *
 * @verifiedBy packages-next/app/src/__tests__/telemetry.spec.ts
 */
export function normalizeTelemetry(setting: TelemetrySetting | undefined): NormalizedTelemetry {
  if (setting === undefined || setting === false) return { enabled: false };
  if (setting === true) return { enabled: true };
  if (Layer.isLayer(setting)) return { enabled: true, layer: setting as TelemetryLayer };
  // Config-object form (`Layer.isLayer` variance markers block negative
  // union-narrowing, so name it explicitly).
  const opts = setting as TelemetryOptions;
  return {
    enabled: true,
    ...(opts.layer !== undefined ? { layer: opts.layer } : {}),
    ...(opts.serviceName !== undefined ? { serviceName: opts.serviceName } : {}),
    ...(opts.attributes !== undefined ? { attributes: opts.attributes } : {}),
  };
}

/** Config the switch normalizes into (the enrichment inputs). */
export interface TelemetryDefaultsConfig {
  /** `<ns>.app_name` + the default `<ns>.function_id` (rung 1's app-name default). */
  readonly appName?: string;
  /** `<ns>.service_name`. */
  readonly serviceName?: string;
  /** Static attributes stamped on every span (construction-time seam). */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

// The op-scoping key is `ctx.op` — the Pascal command suffix `runOperation`
// stamps on the RuntimeContext (`deriveHookNames("x:command:y")[0]` minus the
// "onBefore" prefix; the exact twin of `SessionModelFacade`'s GENERATE_OP).
const opKey = (opName: string): string => deriveHookNames(opName)[0].slice("onBefore".length);
const MODEL_GENERATE = opKey("model:command:generate");
const MODEL_GENERATE_STREAM = opKey("model:command:generate_stream");
const MODEL_RUN = opKey("model:command:run");
const MODEL_NORMALIZE = opKey("model:command:normalize");
const TOOL_DISPATCH = opKey("tool:command:dispatch");
const LOOP_TICK = opKey("loop:command:tick");

/** Model-call ops whose result carries a normalized {@link UsageStats}. */
const MODEL_USAGE_OPS = new Set([
  MODEL_GENERATE,
  MODEL_GENERATE_STREAM,
  MODEL_RUN,
  MODEL_NORMALIZE,
]);

/**
 * Scope an Effect-native {@link Middleware} to a set of `ctx.op` values — the
 * in-fiber twin of the substrate's `scopeToCommand` (which is AsyncMiddleware
 * only). Off-scope ops pass straight through, so the enrichment is inert on
 * every op it does not target.
 */
function onOps<I, R>(
  ops: ReadonlySet<string>,
  mw: Middleware<I, R, unknown>,
): Middleware<I, R, unknown> {
  return (input, next) =>
    Effect.gen(function* () {
      const ctx = yield* getContext;
      if (ctx.op !== undefined && ops.has(ctx.op)) return yield* mw(input, next);
      return yield* next(input);
    });
}

/** Read a `.target` off a model-call op input (best-effort, defensive). */
function inputTarget(input: unknown): ExecutionTarget | undefined {
  const t = (input as { target?: unknown } | undefined)?.target;
  return t !== undefined ? (t as ExecutionTarget) : undefined;
}

/** Read a normalized `.usage` off a model-call result (best-effort, defensive). */
function resultUsage(result: unknown): UsageStats | undefined {
  const u = (result as { usage?: unknown } | undefined)?.usage;
  return u !== undefined && typeof (u as UsageStats).inputTokens === "number"
    ? (u as UsageStats)
    : undefined;
}

/**
 * Build the rung-1 enrichment interceptor list from the normalized config. Each
 * entry is a rung-3 helper instance; the usage/cost entry reads the model
 * result then annotates via {@link annotateOperationSpan}. Order is irrelevant
 * (all pure annotators). Never empty when called (the switch calls it only when
 * enrichment is on), so the session reads `telemetryMiddleware.length > 0` as
 * "enrichment on".
 *
 * @verifiedBy packages-next/app/src/__tests__/telemetry.spec.ts
 */
export function buildTelemetryInterceptors(
  ns: string,
  config: TelemetryDefaultsConfig,
): Middleware<unknown, unknown, unknown>[] {
  const list: Middleware<unknown, unknown, unknown>[] = [];

  // Global identity — stamped on EVERY op. `<ns>.function.id` defaults to the
  // app name here (rung 1); a per-call `SendInput.telemetry.functionId`
  // (rung 2) composes innermost and overrides it. `service.name` is the
  // STANDARD OTel resource key (not whitelabeled). Adopter `attributes` keys
  // are stamped verbatim.
  const globalAttrs: Record<string, unknown> = {};
  if (config.appName !== undefined) {
    globalAttrs[`${ns}.app.name`] = config.appName;
    globalAttrs[`${ns}.function.id`] = config.appName;
  }
  if (config.serviceName !== undefined) globalAttrs["service.name"] = config.serviceName;
  for (const [k, v] of Object.entries(config.attributes ?? {})) globalAttrs[k] = v;
  if (Object.keys(globalAttrs).length > 0) list.push(spanAttributes(() => globalAttrs));

  // Model identity — GenAI semconv `gen_ai.request.model` / `gen_ai.system`
  // (verbatim, vendor-recognized) off the op input's target.
  list.push(
    onOps<unknown, unknown>(
      new Set([MODEL_GENERATE, MODEL_GENERATE_STREAM, MODEL_RUN]),
      spanAttributes((input) => {
        const target = inputTarget(input);
        if (target === undefined) return {};
        return { "gen_ai.request.model": target.modelId, "gen_ai.system": target.provider };
      }),
    ),
  );

  // Token usage + cost — read the model result, estimate cost, annotate the
  // model-call span. Usage tokens use GenAI semconv verbatim; total-tokens +
  // cost have no GenAI standard, so they stay framework-namespaced.
  // `estimateCost` returns undefined for un-priced models (never fabricates
  // zeros); usage-only ops still stamp token counts.
  const usageCost: Middleware<unknown, unknown, unknown> = (input, next) =>
    Effect.gen(function* () {
      const result = yield* next(input);
      const usage = resultUsage(result);
      if (usage === undefined) return result;
      const attrs: Record<string, unknown> = {
        "gen_ai.usage.input_tokens": usage.inputTokens,
        "gen_ai.usage.output_tokens": usage.outputTokens,
        [`${ns}.usage.total_tokens`]: usage.totalTokens,
      };
      const finish = (result as { stopReason?: unknown } | undefined)?.stopReason;
      if (typeof finish === "string") attrs["gen_ai.response.finish_reason"] = finish;
      const target = inputTarget(input);
      if (target !== undefined) {
        const cost = estimateCost(usage, target);
        if (cost !== undefined) {
          attrs[`${ns}.usage.cost_input_usd`] = cost.inputUSD;
          attrs[`${ns}.usage.cost_output_usd`] = cost.outputUSD;
          attrs[`${ns}.usage.cost_usd`] = cost.totalUSD;
        }
      }
      yield* annotateOperationSpan(attrs);
      return result;
    });
  list.push(onOps(MODEL_USAGE_OPS, usageCost));

  // Tool identity — `<ns>.tool.name` off the dispatch input.
  list.push(
    onOps<unknown, unknown>(
      new Set([TOOL_DISPATCH]),
      spanAttributes((input) => {
        const name = (input as { name?: unknown } | undefined)?.name;
        return typeof name === "string" ? { [`${ns}.tool.name`]: name } : {};
      }),
    ),
  );

  // Tick index — `<ns>.tick.index` off the TickInput (1-based).
  list.push(
    onOps<unknown, unknown>(
      new Set([LOOP_TICK]),
      spanAttributes((input) => {
        const idx = (input as { tickIndex?: unknown } | undefined)?.tickIndex;
        return typeof idx === "number" ? { [`${ns}.tick.index`]: idx } : {};
      }),
    ),
  );

  return list;
}
