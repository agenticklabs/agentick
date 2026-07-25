---
"@agentick/spec": patch
---

Move harness conformance suites off public barrels onto the `./testing`
subpath, and declare runtime dependencies the hoisted workspace masked.

`@agentick/elicitation/dist/conformance.js` (plus 11 sibling packages)
imported `vitest` from a MAIN-barrel re-export, so a registry consumer
install of `@agentick/session` failed at require time (`vitest` is a
devDependency the consumer never installs). Conformance and
store-conformance suites now ship only from each package's `./testing`
subpath — test infrastructure is never reachable from the main graph.
`@agentick/cluster`'s public `./conformance` subpath is removed (folded
into `./testing`).

Also declares runtime dependencies that the workspace's hoisted
`node_modules` had masked: `app` → `knobs` + `model-executor`,
`model-executor` → `utils`, `session` → `tool-executor` +
`model-executor` + `compiler-react`, `cluster` → `runtime`, and
`sandbox` → `zod` (optional peer, for the `./react` subpath).

Enforced going forward by the new `dep-graph` gate wired into
`verify:publish`: every published entrypoint's dist import graph must
reach only declared `dependencies` / `peerDependencies` /
`optionalDependencies` (`vitest` is allowlisted on `./testing` only).

The fixed group carries every @agentick v2 package to the next patch
together.
