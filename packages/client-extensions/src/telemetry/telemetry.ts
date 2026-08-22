/**
 * `telemetry(options)` — `ClientExtension` that opens a span per
 * logical RPC, propagates W3C Trace Context to the server via the MCP
 * `_meta` slot, and records OpenTelemetry RPC semantic-convention
 * attributes.
 *
 * BYO Tracer per OTel norms: we don't bundle `@opentelemetry/api`.
 * Adopters provide a minimal `TelemetryAdapter` — typically a thin
 * wrapper around `@opentelemetry/api`'s `trace.getTracer(...)`. A
 * `noopAdapter` is exported for tests / adopters who only want trace
 * context propagation without observation.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/
 * @see https://www.w3.org/TR/trace-context/
 * @verifiedBy src/__tests__/telemetry.spec.ts
 */

import type {
  ClientExtension,
  RequestMiddleware,
  TelemetryAdapter,
  TelemetrySpan,
} from "@agentick/spec";
import { NOOP_TELEMETRY_ADAPTER } from "@agentick/spec";

// The adapter contract moved to `@agentick/spec` so `client-core` can build the
// ctx facets (`ctx.log` / `ctx.trace` / `ctx.metrics`) over the SAME instance an
// adopter wires here. One object, wired once, consumed twice — which is what
// makes a span opened in a tool handler the parent of the RPC it triggers.
export type { TelemetryAdapter, TelemetrySpan };
import { generateTraceparent } from "./trace-context.js";

export interface TelemetryOptions {
  readonly adapter: TelemetryAdapter;
  /**
   * Per-method sampler. Return `false` to skip span creation entirely
   * for noisy methods (e.g., `session/dry_run`). Default: sample all.
   */
  readonly sample?: (method: string) => boolean;
  /**
   * Service name reported as `rpc.service`. Defaults to `agentick`.
   */
  readonly serviceName?: string;
}

/** No-op adapter — trace context propagation only, no local recording. */
export const noopAdapter: TelemetryAdapter = NOOP_TELEMETRY_ADAPTER;

export function telemetry(options: TelemetryOptions): ClientExtension {
  const sample = options.sample ?? (() => true);
  const serviceName = options.serviceName ?? "agentick";

  const adapter = options.adapter;

  const requestMw: RequestMiddleware = async (req, next) => {
    const method = req.method;

    // Always propagate trace context — even when we're not opening a
    // local span — so the server-side span tree is well-formed. The sampled
    // bit reports whether we ACTUALLY open one: an unsampled method that
    // claimed `01` would promise a client span that never gets recorded.
    const sampled = sample(method);
    const tc = adapter.currentTraceContext();
    const traceparent = tc.traceparent ?? generateTraceparent(sampled);
    const tracestate = tc.tracestate;

    const requestWithContext = withTraceContext(req, traceparent, tracestate);

    if (!sampled) {
      return next(requestWithContext);
    }

    // OTel RPC semantic conventions:
    //   - span name = "${rpc.service}/${rpc.method}"
    //   - rpc.system, rpc.service, rpc.method as attributes
    //   - rpc.jsonrpc.version, rpc.jsonrpc.request_id
    const span = adapter.startSpan(`${serviceName}/${method}`, {
      "rpc.system": "jsonrpc",
      "rpc.service": serviceName,
      "rpc.method": method,
      "rpc.jsonrpc.version": "2.0",
    });

    const start = nowMs();
    try {
      const result = await next(requestWithContext);
      const duration = nowMs() - start;
      span.setAttribute("rpc.duration_ms", duration);
      return result;
    } catch (err) {
      const duration = nowMs() - start;
      span.setAttribute("rpc.duration_ms", duration);
      const message = extractErrorMessage(err);
      span.setError(message);
      const code = extractRpcCode(err);
      if (code !== undefined) span.setAttribute("rpc.jsonrpc.error_code", code);
      throw err;
    } finally {
      span.end();
    }
  };

  return {
    name: "telemetry",
    request: requestMw,
  };
}

function withTraceContext<R extends { params: unknown }>(
  req: R,
  traceparent: string,
  tracestate: string | undefined,
): R {
  const params = req.params as Record<string, unknown> | undefined;
  const meta = (params?._meta as Record<string, unknown> | undefined) ?? {};
  const tc: Record<string, unknown> = { traceparent };
  if (tracestate) tc.tracestate = tracestate;
  return {
    ...req,
    params: { ...(params ?? {}), _meta: { ...meta, ...tc } },
  };
}

function nowMs(): number {
  const g = globalThis as { performance?: { now(): number } };
  if (g.performance?.now) return g.performance.now();
  return Date.now();
}

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { error?: { message?: string }; message?: string };
    return e.error?.message ?? e.message ?? "unknown";
  }
  return String(err);
}

function extractRpcCode(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { error?: { code?: number } };
    return e.error?.code;
  }
  return undefined;
}
