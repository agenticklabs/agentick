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

import type { ClientExtension, RequestMiddleware } from "@agentick/spec-next";
import { generateTraceparent } from "./trace-context.js";

/**
 * Minimal span shape — matches the subset of OpenTelemetry's `Span`
 * interface the middleware actually calls. Adopters wrap a real OTel
 * span here or supply their own observer.
 */
export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  /** Set status to "error" with the given message. */
  setError(message: string): void;
  end(): void;
}

/**
 * BYO tracer adapter — adopter typically wraps `@opentelemetry/api`'s
 * `trace.getTracer("@agentick/client-next").startSpan(name, { kind: SpanKind.CLIENT })`.
 *
 * The adapter is also responsible for telling us what
 * `traceparent` / `tracestate` to propagate downstream so the
 * server-side span links to the client's span. If you return
 * `undefined` for `traceparent`, the middleware generates one.
 */
export interface TelemetryAdapter {
  startSpan(name: string, attributes: Record<string, string | number | boolean>): TelemetrySpan;
  /** Return the W3C Trace Context fields to propagate on the wire. */
  currentTraceContext(): { traceparent?: string; tracestate?: string };
}

export interface TelemetryOptions {
  readonly adapter: TelemetryAdapter;
  /**
   * Per-method sampler. Return `false` to skip span creation entirely
   * for noisy methods (e.g., `session/snapshot`). Default: sample all.
   */
  readonly sample?: (method: string) => boolean;
  /**
   * Service name reported as `rpc.service`. Defaults to `agentick`.
   */
  readonly serviceName?: string;
}

/**
 * No-op adapter — useful when you only want trace context propagated
 * (no local span recording).
 */
export const noopAdapter: TelemetryAdapter = {
  startSpan: () => ({
    setAttribute() {},
    setError() {},
    end() {},
  }),
  currentTraceContext: () => ({}),
};

export function telemetry(options: TelemetryOptions): ClientExtension {
  const adapter = options.adapter;
  const sample = options.sample ?? (() => true);
  const serviceName = options.serviceName ?? "agentick";

  const requestMw: RequestMiddleware = async (req, next) => {
    const method = req.method;

    // Always propagate trace context — even when we're not opening a
    // local span — so the server-side span tree is well-formed.
    const tc = adapter.currentTraceContext();
    const traceparent = tc.traceparent ?? generateTraceparent();
    const tracestate = tc.tracestate;

    const requestWithContext = withTraceContext(req, traceparent, tracestate);

    if (!sample(method)) {
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
