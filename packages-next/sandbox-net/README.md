# @agentick/sandbox-net-next

The pure, OS-free **network egress matcher** shared by every
egress-enforcing sandbox provider (ADR 59).

## Purpose

Sandbox network policy is a list of ordered `NetworkRule`s. This package is
the **decision function** over that list: first-match-wins, default-deny,
`*.domain` wildcards. It is pure — no sockets, no proxy server — so the
matcher is reusable by:

- `@agentick/sandbox-local-next` — the 127.0.0.1 HTTP proxy that enforces
  policy per request.
- a future docker/remote enforcer — which applies the same rule semantics
  through `NetworkMode` or its own egress path.

Putting the matcher in `sandbox-local-next` would force `docker → local`
(wrong direction). It lives here, depending on `spec-next` only.

## Quick Start

```ts
import { matchRequest, matchDomain } from "@agentick/sandbox-net-next";
import type { NetworkRule } from "@agentick/spec-next";

const rules: NetworkRule[] = [
  { action: "deny", domain: "*.internal.corp" },
  { action: "allow", domain: "api.github.com" },
];

matchRequest(
  { host: "api.github.com", port: 443, method: "GET", url: "https://api.github.com/user" },
  rules,
); // → { action: "allow", rule: rules[1] }

matchDomain("sub.example.com", "*.example.com"); // → true
```

## API

- `matchRequest(request: NetworkRequest, rules: readonly NetworkRule[]): MatchResult`
  — evaluate in order; first match wins; unmatched → `{ action: "deny" }`.
- `matchDomain(hostname: string, pattern: string): boolean` — exact or
  `*.domain` wildcard, case-insensitive.
- `type NetworkRequest` — `Pick<ProxiedRequest, "host" | "port" | "method" | "url">`.
- `type MatchResult` — `{ action; rule? }`.

`NetworkRule` / `ProxiedRequest` are the wire vocabulary in
`@agentick/spec-next`.

## Status

Stable. Ported faithfully from v1 `@agentick/sandbox-local/network/rules.ts`.

## Roadmap & known gaps

- CIDR / IP-range rules are not supported — matching is domain/port/
  method/urlPattern only, mirroring v1.

## Verified by

- `src/__tests__/rules.spec.ts` — ordering, default-deny, wildcard
  semantics, per-field predicates, invalid-regex handling.
