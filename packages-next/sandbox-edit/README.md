# @agentick/sandbox-edit-next

The pure, OS-free **surgical edit transform** (`applyEdits`) shared by the
sandbox harness and every sandbox provider (ADR 59, Wave 2).

## Purpose

`editFile` is the one sandbox tool that beats `sed`: layered matching that
recovers from trailing-whitespace, indentation, and CRLF/LF drift, plus a
full mode set (replace / delete / insert / range), overlap detection, and
diagnostic errors the model can self-correct from.

That transform is **pure** (no I/O). It was extracted out of
`@agentick/sandbox-next` so providers — which depend on `spec-next` only and
**must not** import the harness package — can run the same code the harness
runs. `@agentick/sandbox-next` re-exports `applyEdits`/`EditError` from here.

The `editFile` **file-wrapper** (read → transform → atomic temp+rename) is
NOT here: temp+rename is a filesystem concern owned by the provider layer.
This package is the text transform, nothing more.

## Quick Start

```ts
import { applyEdits, EditError } from "@agentick/sandbox-edit-next";

const result = applyEdits("function foo() {\n  return 1;\n}", [
  { old: "return 1;", new: "return 2;" },
]);
// result.content === "function foo() {\n  return 2;\n}"
// result.applied === 1
// result.changes  === [{ line: 2, removed: 1, added: 1 }]
```

## API

- `applyEdits(source: string, edits: readonly SandboxEdit[]): SandboxEditResult`
  — pure transform. Mode detected by field presence (precedence:
  range > insert > delete > replace). Matching per anchor: exact →
  line-normalized → indent-adjusted. Multi-edit resolved against the
  original source, overlap-validated, applied bottom-to-top.
- `class EditError` — thrown on match failure, validation error, or
  overlapping edits. Carries `editIndex` + `detail` (closest partial
  match, line, context snippet) for model self-correction.

Types (`SandboxEdit`, `SandboxEditResult`, `SandboxEditChange`) live in
`@agentick/spec-next`.

## Status

Stable. Ported faithfully from v1 `@agentick/sandbox/edit.ts`.

## Roadmap & known gaps

None. The transform is feature-complete against the v1 behavior.

## Verified by

- `src/__tests__/edit.spec.ts` — 3-strategy matching, all modes, smart
  line deletion, CRLF normalization, multi-edit overlap detection,
  diagnostic errors.
- `@agentick/sandbox-local-next`'s conformance run
  (`runSandboxProviderConformance`) exercises `applyEdits` through a real
  provider's atomic `editFile`.
