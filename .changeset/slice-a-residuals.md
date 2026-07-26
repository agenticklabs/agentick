---
"@agentick/spec": minor
---

ADR 92 Slice A residuals. Effect-native `fx` faces on the Resources +
Prompts protocols (`ResourcesFx.read/list/listTemplates`,
`PromptsFx.render`, derived via the existing `fxProxy` convention) let
the MCP projection run harness reads on the crossing's fiber — wire
identity now reaches resource resolvers and prompt render, closing ADR
91's last starved-seam gap: every adopter handler seam (tool,
completion, resolver, render) receives the request identity on the
trunk. `runHarnessProtocolOn(runtime, effect)` joins the substrate.
Transport-side admission-failure visibility: `gateway:admission:failed`
event emitted on rejected ingress across http/ws/unix-socket
(connection shape + failure class, never credential material — asserted
in shared conformance), via a pure `onRejected` reporter callback on
`authenticateIngress`.
