---
"@agentick/transport": minor
---

Transport hardening, thirteen findings fixed test-first. Security:
DELETE now authenticates like POST/GET (http); authentication gained a
wall-clock ceiling at the shared ingress seam (default 10s,
`authnTimeoutMs` per edge, `Infinity` opts out) — a hung AuthSource
refuses instead of leaking the request/socket. Correctness: in-process
client→server notifications now route (cancellation actually aborts
server-side work); a real per-connection context replaces the no-op
sink (teardown releases server-side subscriptions);
`sub/unsubscribe` now RUNS cleanups instead of forgetting them (leaked
on every transport). Unix socket: bind errors are claimed
(`listening()` — stale socket files no longer crash the process),
NDJSON lines capped (`maxLineBytes`, default 16 MiB, typed
frame-too-large + close), connect failures are typed Errors
(`transportError`), socket failures reportable via `onFailure` (quiet
by default). Honest capabilities: `binaryFrames` reflects `wireParity`;
the websocket package description no longer advertises unshipped
features.
