/**
 * `@agentick/sandbox-net-next` — the pure, OS-free network egress matcher.
 *
 * First-match-wins, default-deny, `*.domain` wildcards. Shared by every
 * egress-enforcing sandbox provider: the local HTTP proxy
 * (`sandbox-local-next`), and future docker/remote enforcers. Depends on
 * `spec-next` only (ADR 59).
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

export { matchRequest, matchDomain, type MatchResult, type NetworkRequest } from "./rules.js";
