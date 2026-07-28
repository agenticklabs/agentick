---
"@agentick/tool-executor": minor
---

`toolConfirmation(elic)` — the reader for the tool-confirmation contract, on
`@agentick/tool-executor/client`. `ConfirmRequest` was exported as a TYPE with
nothing that produces one: the mapping from an elicitation's
`metadata.{toolName,toolUseId,arguments,preview}` + `message` lived in a private
`toRequest`, so the documented "draw your own confirmation dialog" path had a
shape to fill and no way to fill it. The first real consumer hand-rolled the
mapping and dropped `preview` — every tool with a `confirmationPreview` rendered
an empty dialog body.

The reader NARROWS: `undefined` when `hints.kind !== "tool_confirmation"`, so it
doubles as the discriminator a UI needs while walking
`session.elicitations.list()` — no hardcoded hint string, no second pass. Its
parameter is structural, so a `ClientElicitationHandle` off `list()` fits with no
cast. `confirmClientTools` now filters through the same reader; the private
`toRequest` is gone, so there is one mapping rather than two that can drift.
