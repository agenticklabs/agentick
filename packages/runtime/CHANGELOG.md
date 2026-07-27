# @agentick/runtime

## 1.0.0-next.18

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.18
  - @agentick/utils@1.0.0-next.18

## 1.0.0-next.17

### Minor Changes

- SECURITY: the MCP identity stamp no longer carries the caller's
  credential. `toIngressIdentity` spread the WHOLE authenticated user
  record onto `IngressIdentity.user`, which rides `EventScope` on every
  crossing — and `call-tool` / `initialize` are the persisted journal
  classes — so an authenticator that hangs a bearer token off the record
  (the common shape: tool handlers need it) wrote a live credential into
  the durable journal on every tool call, contradicting the function's own
  "never the credential itself" contract and the ADR 92 redaction law.

  The stamp is now STRUCTURALLY safe: the default projection copies only
  the four fields `McpAuthenticatedUser` declares (`id`, `displayName`,
  `roles`, `scopes`) and cannot read a key it does not name — adopter-bag
  fields, where credentials and PII live, are never copied. The new
  `identityProjection` option on the MCP server config is the adopter's
  redaction/sanitization seam: what it returns becomes `identity.user`
  verbatim, while `principal` and `scopes` stay framework-derived.

  The credential keeps a legitimate home. `@agentick/runtime` gains
  `BoundaryFacetsRef` / `withBoundaryFacets` — an in-fiber channel that
  `deriveContext` folds into a derived context as extras and that
  `inheritScope` never reads, so it cannot reach an event scope, the bus,
  or the journal. The MCP crossing publishes its `mcp` facet there, so
  `ctx.mcp.user` (credential included) now reaches every handler seam:
  tool handlers, the three per-connection filters, completion handlers,
  `PromptDeclaration.render`, and resource resolvers. Verified by a
  combined assertion driving all five crossings — the facet is read, and
  neither the serialized bus nor the serialized journal contains the
  credential.

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.17
  - @agentick/utils@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.16
  - @agentick/utils@1.0.0-next.16

## 1.0.0-next.15

### Minor Changes

- ADR 93 D3 — skills + prompts join the definition grammar.
  `defineSkills({ store?, hydrate?, hooks?, guards? })` and
  `definePrompts({ ... })` — identity + brand, inert until per-session
  install, the D1 pattern verbatim. Source unification: the parallel
  source-config vocabulary is DELETED (moot #3) in favor of named
  hydrators — `hydrateFromDirectory(dir)`, `composeHydrators(...)`, and
  literal seeding — with the node-only directory loader split onto its
  own subpath so browser bundles stay clean; the package `./loaders`
  subpath is renamed `./hydrators`. Prompts gains `store?` (moot #4 — the
  withPrompts-lacks-store asymmetry dies). Genesis default for both is
  none/explicit; the three genesis laws are enforced and tested
  (seed-never-append, fork/spawn never re-runs genesis, a throwing
  hydrator fails session creation with typed `SkillsHydrateFailed` /
  `PromptsHydrateFailed`). `hydrate(ctx)` carries the typed store facet
  and trunk identity — `ctx.principal` is readable, the tiered-catalog
  seam. `createApp({ skills, prompts })` top-level slots land via the
  same augmentation + side-effect slot registration as timeline.

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
  - @agentick/spec@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/spec@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
