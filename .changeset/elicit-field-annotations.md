---
"@agentick/spec": minor
"@agentick/elicitation": minor
---

Elicitation fields gain presentation annotations — `hint`, `info`, `placeholder`
— on `ElicitFieldAnnotations`. Every form-mode `Elicit` method (`text`, `select`,
`number`, …) accepts them, and `form` schemas can carry them per property. They
ride the field's JSON Schema and affect nothing but rendering:

- `hint` — a short qualifier shown inline with the label.
- `info` — longer help for a tooltip; a renderer falls back to JSON Schema
  `description` when absent.
- `placeholder` — ghost text inside the control.

Together with `title` (label) and `description` (help), these are the full
label/help vocabulary a client draws a field header from — first-class in the
elicit contract, so MCP servers and the in-process sugar express them the same
way. Emitted by the shared `flat-props` builders, so both transports carry them.
