# @agentick/compiler-react

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.16
  - @agentick/formatters@1.0.0-next.16
  - @agentick/runtime@1.0.0-next.16
  - @agentick/spec@1.0.0-next.16
  - @agentick/tool@1.0.0-next.16
  - @agentick/utils@1.0.0-next.16

## 1.0.0-next.15

### Minor Changes

- Verified-defect hygiene slice, every behavior fix red-first. `<H1>`–`<H3>`
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

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.15
  - @agentick/formatters@1.0.0-next.15
  - @agentick/runtime@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/tool@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.14
  - @agentick/formatters@1.0.0-next.14
  - @agentick/runtime@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/tool@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.13
  - @agentick/formatters@1.0.0-next.13
  - @agentick/runtime@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/tool@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.12
  - @agentick/formatters@1.0.0-next.12
  - @agentick/runtime@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/tool@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.11
  - @agentick/formatters@1.0.0-next.11
  - @agentick/runtime@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/tool@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.10
  - @agentick/formatters@1.0.0-next.10
  - @agentick/runtime@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/tool@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.9
  - @agentick/formatters@1.0.0-next.9
  - @agentick/runtime@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/tool@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.8
  - @agentick/formatters@1.0.0-next.8
  - @agentick/runtime@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/tool@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.7
  - @agentick/formatters@1.0.0-next.7
  - @agentick/runtime@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/tool@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.6
  - @agentick/formatters@1.0.0-next.6
  - @agentick/runtime@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/tool@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.5
  - @agentick/formatters@1.0.0-next.5
  - @agentick/runtime@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/tool@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.4
  - @agentick/formatters@1.0.0-next.4
  - @agentick/runtime@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/tool@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.3
  - @agentick/formatters@1.0.0-next.3
  - @agentick/runtime@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/tool@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.2
  - @agentick/formatters@1.0.0-next.2
  - @agentick/runtime@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/tool@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
