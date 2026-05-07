---
"@agentick/kernel": patch
---

Add baggage primitive: ambient span attributes that propagate through the execution context.

- `KernelContext.baggage?: Record<string, AttributeValue>` — new field on the context.
- `Context.withBaggage(attrs)` — merges `attrs` onto the current ALS context's baggage. Last writer wins per key. Scope comes from existing `Context.fork`/`Context.run` boundaries — no separate scope-callback API. To get scoped baggage that restores on exit, fork first and call `withBaggage` inside.
- `proc.withBaggage(attrs)` — procedure variant that forks before applying baggage, so the caller's context is unaffected. Mirrors `withContext`/`withMetadata`.
- `Telemetry.startSpan(name)` reads active baggage and applies it via `setAttributes` before returning the span. Provider-agnostic — every provider (no-op, OTel adapter, custom) picks it up automatically with no provider-side change. Falls back to per-key `setAttribute` for providers that don't implement `setAttributes`.

Modeled on OpenTelemetry baggage but uses agentick's existing ALS scoping (`Context.fork`/`Context.run`) instead of a parallel `with(baggage, fn)` callback API. One scoping primitive across the kernel, no fragmented mental model.
