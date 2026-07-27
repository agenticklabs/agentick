---
"@agentick/runtime": minor
"@agentick/compiler-react": minor
"@agentick/formatters": minor
"@agentick/session": minor
---

Verified-defect hygiene slice, every behavior fix red-first. `<H1>`–`<H3>`
and `<Paragraph>` actually render now — the wrappers emitted `heading`/
`paragraph` intrinsics no contributor claims, so heading levels and block
boundaries were silently dropped; they now emit the claimed `h1`–`h3`/`p`
(byte-identical to the lowercase intrinsics, pinned). `guard(...)` bags
of inline verdict literals contextually type without `as const` — the
decider/bag overload pair collapsed into one union signature. A
`renderedWith` or caller-pinned formatter ref that matches neither a
registered id nor a format is now reported as a `formatter-unresolved`
warning diagnostic (once per distinct ref; the tree still renders through
the default) — new shared `resolveFormatterRef`/`describeUnresolvedFormatter`
exports in @agentick/formatters are the one lookup both `formatTree` and
the compiler harness use, and the mount now binds the harness's real
default ref instead of a sentinel. `defineSession`'s no-op model handle
reads `current` as `undefined` (the documented model-less case) instead
of throwing; writes still reject. Plus: direct unit suites for
`ulid`/`waitFor`/`waitForStable`, and accurate barrel docblocks for spec
and eval.
