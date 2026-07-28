---
"@agentick/spec": minor
---

Consumers on `"moduleResolution": "node"` (node10) can now import subpaths.
node10 predates the `exports` map and ignores it, so `@agentick/mcp/server`,
`@agentick/transport-websocket/server`, `@agentick/app/react` and every other
subpath failed to resolve — and 27 of the resulting errors read "has no exported
member" for members that ARE in the shipped `.d.ts`, sending adopters after an
API that was never removed. Runtime was never affected; Node honors `exports`
regardless. Every published package now carries a `typesVersions` fallback
derived from its own exports map, with an anti-rot sweep so a new subpath cannot
ship without one.
