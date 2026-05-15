# Cluster (Optional Topology Wrapper)

## Status: Living Draft

Last updated: 2026-05-08

`@agentick/cluster` is an optional topology layer that wraps runtime harnesses
for distributed deployment. It does not redefine core runtime contracts.

The core runtime remains library-first and in-process capable.

## Purpose

Cluster mode adds:

- distributed routing to session/app harnesses
- remote lifecycle activation/deactivation
- cross-node event fan-out and aggregation
- optional migration/failover behavior

All of this composes through harness protocols.

## Non-Goals

- redefining runtime semantics
- introducing cluster-specific authoring APIs in compiler/react surface
- changing compiled spec format
- making distributed topology mandatory

## Wrapping Model

```
Local App/Session harnesses
  -> wrapped by cluster routing/activation layer
  -> exposed as distributed references
```

Callers still use the same harness commands conceptually; transport and routing
are wrapper concerns.

## Design Principles

1. **Topology over semantics.** Cluster changes where operations run, not what
   they mean.
2. **Harness-preserving wrappers.** Wrapped commands/events/interceptors/outcomes
   remain contract-compatible.
3. **Optional adoption.** Any app can run without this package.
4. **Single-trust-domain default.** Federation is out of scope unless explicitly
   added later.
5. **Operational clarity.** Routing, failover, and replay policies are explicit.

## Cluster Responsibilities

- route app/session commands to active nodes
- activate idle sessions on demand
- mirror and aggregate harness events across nodes
- coordinate lifecycle transitions during node changes
- provide durability coordination interceptors where configured

## Runtime Responsibilities (Unchanged)

- tick orchestration
- compiler/executor integration
- tool execution semantics
- command/hook semantics
- core error taxonomy

## Event Strategy in Cluster Mode

Cluster mode may add:

- node and routing metadata on mirrored events
- aggregate app-level streams across members
- replay windows for reconnecting observers

It should not mutate event meaning from underlying harnesses.

## Failure and Recovery

Cluster wrappers should define explicit behavior for:

- node unavailability
- command retry semantics
- in-flight execution interruptions
- activation race handling
- idempotency of lifecycle transitions

These behaviors are wrapper policy documents, not runtime core behavior changes.

## Testing Strategy

Cluster testing should validate:

- harness contract preservation under distribution
- routing correctness
- activation/deactivation behavior
- failover and reconnection behavior
- event aggregation and ordering guarantees

Core runtime tests should pass unchanged without cluster infrastructure.

## Relationship to Gateway

Gateway concerns (auth, transport protocols, client session bindings) are
separate and documented in [`gateway.md`](./gateway.md). Gateway may depend on
cluster mode but does not replace it.

## Open Questions

1. **Routing substrate choice.** Which cluster implementation is the default?
2. **Activation policy ownership.** Runtime policy interceptors vs cluster
   package policy?
3. **Cross-node ordering guarantees.** Per-session strict ordering vs best
   effort with IDs?
4. **Durability coupling.** What persistence guarantees are required before
   enabling migration semantics?
5. **Operational profile defaults.** Sensible baseline settings for small vs
   large deployments?

## Decision Log

- **Cluster is an optional wrapper package, not runtime core identity.**
  (2026-05-08)
- **Harness contracts are preserved across local and distributed modes.**
  (2026-05-08)
- **Compiled spec and compiler authoring are topology-agnostic.** (2026-05-08)
