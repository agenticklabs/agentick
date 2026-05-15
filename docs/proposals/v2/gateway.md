# Gateway (Optional Ingress Wrapper)

## Status: Living Draft

Last updated: 2026-05-08

`@agentick/gateway` is an optional ingress layer that exposes runtime harnesses
through network transports (HTTP, WebSocket, SSE, RPC, etc.).

Gateway is not a replacement for runtime harnesses. It is an adapter over them.

## Purpose

Gateway provides:

- transport protocol handling
- authentication and request admission
- rate limiting and policy enforcement
- client connection lifecycle
- projection of harness commands/events to transport formats

## Non-Goals

- owning session execution semantics
- redefining harness contracts
- embedding provider/model logic
- forcing network deployment for local library usage

## Design Principles

1. **Harness-backed operations.** Every gateway route/message maps to a harness
   command or stream.
2. **Stateless ingress where possible.** Durable state belongs to runtime
   (and optional cluster wrappers), not gateway workers.
3. **Policy at the edge, semantics in the runtime.** Auth and quotas at
   gateway; execution semantics in runtime harnesses.
4. **Transport plurality.** One internal mapping, multiple external protocols.
5. **Optional package.** Library-only users should not depend on gateway.

## Mapping Model

```
Client transport message
  -> gateway validation/auth
  -> harness command invocation
  -> harness result/event projection
  -> transport response/stream
```

Gateway should preserve typed error categories even when transport error shapes
must be normalized.

## Session Affinity and Routing

Gateway may run in:

- local mode (same process as runtime)
- split mode (separate ingress processes)
- cluster-aware mode (routing through cluster wrapper)

Routing strategy is deployment policy, not gateway semantic identity.

## Event Streaming

Gateway projects harness events to client stream protocols.

Required capabilities:

- subscribe/unsubscribe lifecycle
- replay/resume semantics where supported
- session-scoped and app-scoped event feeds
- backpressure and disconnect handling policy

## Security and Policy

Gateway is the preferred layer for:

- authn/authz checks before command invocation
- tenant scoping
- request quotas and rate limits
- audit logging at ingress

Runtime should still enforce critical invariants; gateway is not a trust bypass.

## Testing Strategy

Gateway tests should validate:

- transport-to-harness mapping correctness
- auth and policy enforcement
- streaming and reconnect behavior
- error projection fidelity
- protocol conformance for each supported transport

## Relationship to Other Docs

- [`runtime.md`](./runtime.md): core harness semantics
- [`cluster.md`](./cluster.md): optional distributed routing wrapper
- [`spec-package.md`](./spec-package.md): shared contract shapes

## Open Questions

1. **Default transport set for v2.** Which protocols are first-class?
2. **Resume semantics.** Mandatory or transport-specific optional?
3. **Error envelope standardization.** Single gateway error schema vs
   transport-native mapping?
4. **Policy plugin API.** Middleware shape for auth/rate/audit composition?
5. **Operational deployment guidance.** When to co-locate vs separate gateway
   fleet?

## Decision Log

- **Gateway is an optional ingress wrapper package.** (2026-05-08)
- **Gateway maps to harness contracts; it does not redefine them.**
  (2026-05-08)
- **Auth/policy belong at ingress, execution semantics remain runtime-owned.**
  (2026-05-08)
