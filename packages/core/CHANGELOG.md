# @agentick/core

## 0.15.1

### Patch Changes

- @agentick/kernel@0.15.1
- @agentick/shared@0.15.1
- @agentick/mcp@0.15.1

## 0.15.0

### Patch Changes

- eca7b3c: Rename default MCP resource tool names from `list_resources` / `read_resource` to `list_mcp_resources` / `read_mcp_resource`. The `mcp_` namespace prefix disambiguates from filesystem tools like `read_file` / `glob` — generic names collide cognitively and lead models to confuse MCP URIs with filesystem paths. Tool descriptions also tightened to explicitly call out the URI-vs-path distinction. Callers can still override via the existing `listToolName` / `readToolName` props.
- Updated dependencies [45b99a7]
  - @agentick/mcp@0.15.0
  - @agentick/kernel@0.15.0
  - @agentick/shared@0.15.0

## 0.14.68

### Patch Changes

- @agentick/kernel@0.14.68
- @agentick/shared@0.14.68
- @agentick/mcp@0.14.68

## 0.14.67

### Patch Changes

- c753f82: Default MCP resources render as a path-grouped tree (bounded size, regardless of resource count) instead of a verbose flat listing. Add `renderResources` prop on `MCPResourceComponent` / `MCPComponent` — a renderer function (not a string preset). Built-in alternates exported: `renderResourceTree` (new default), `renderResourceList` (historical behavior). Pass `() => null` to suppress the orientation Section entirely while keeping `list_resources` / `read_resource` tools registered.
  - @agentick/kernel@0.14.67
  - @agentick/shared@0.14.67
  - @agentick/mcp@0.14.67

## 0.14.66

### Patch Changes

- 35d7370: Export missing message hooks
  - @agentick/kernel@0.14.66
  - @agentick/shared@0.14.66
  - @agentick/mcp@0.14.66

## 0.14.65

### Patch Changes

- 3483cbf: Section duplicate warning — switch from `Logger.warn` to dev-only `console.warn`.

  The previous release introduced a `Logger.warn` for duplicate `<Section id>` collisions. That produced a structured pino log line per occurrence, which is too noisy for an authoring-mistake / render-bug warning that should behave like React's `react/jsx-key` warning.

  Now uses plain `console.warn`, gated on `"production" !== process.env.NODE_ENV` (the same yoda-style guard React uses in `react-reconciler.development.js`). Bundler dead-code elimination can strip the warning from production builds; in dev/test it surfaces directly without polluting structured logs.

  - @agentick/kernel@0.14.65
  - @agentick/shared@0.14.65
  - @agentick/mcp@0.14.65

## 0.14.64

### Patch Changes

- 71ce3e0: Section ids: switch from append-merge to last-write-wins, warn on duplicates.

  `collectSection` previously merged content from multiple `<Section id="x">` instances by appending — convenient for "split a long section across components", but turning every render-time duplicate (intentional or not) into silent accumulation. Render-loop retries (fiber-compiler retrying on suspended `useData`) that partially commit before re-rendering produced N copies of the same section, all merged into one bloated output. In production this manifested as MCP resource listings duplicated 6× in the system prompt across ticks.

  **New behavior:** last-write-wins per id, plus a `Logger.warn` when duplicates appear in a single collect pass. The warning surfaces both authoring mistakes and render-loop bugs immediately rather than letting them accumulate silently.

  **Migration:** authors who relied on declaring the same id twice to compose content should pass children to a single `<Section>`:

  ```tsx
  // before — relied on append-merge
  <Section id="x"><A /></Section>
  <Section id="x"><B /></Section>

  // after
  <Section id="x">
    <A />
    <B />
  </Section>
  ```

  The single existing test asserting append-merge was updated to assert last-write-wins.

  - @agentick/kernel@0.14.64
  - @agentick/shared@0.14.64
  - @agentick/mcp@0.14.64

## 0.14.63

### Patch Changes

- Updated dependencies [009aa12]
  - @agentick/shared@0.14.63
  - @agentick/kernel@0.14.63
  - @agentick/mcp@0.14.63

## 0.14.62

### Patch Changes

- Updated dependencies [eb148b9]
  - @agentick/kernel@0.14.62
  - @agentick/mcp@0.14.62
  - @agentick/shared@0.14.62

## 0.14.61

### Patch Changes

- Updated dependencies [02afae6]
  - @agentick/kernel@0.14.61
  - @agentick/mcp@0.14.61
  - @agentick/shared@0.14.61

## 0.14.60

### Patch Changes

- c23d3d1: add dispatchProcedure for one off dispatch of function as procedure and refactor Context.create to Context.child
- Updated dependencies [c23d3d1]
  - @agentick/kernel@0.14.60
  - @agentick/mcp@0.14.60
  - @agentick/shared@0.14.60

## 0.14.59

### Patch Changes

- 1cdc0a3: Add the agent harness — host-facing programmatic methods on `Session` — and a
  full implementation of the [Agent Skills](https://agentskills.io) open spec
  plus Claude Code's substitution and shell-injection extensions.

  **Agent harness:**

  - `session.shell(cmd)` — sugar over `dispatch("bash", { command })`
  - `session.tools.<name>(input)` — typed Proxy with dot-path namespacing
  - `session.append(entry, opts?)` — primitive timeline write
  - `session.observe({ type, content })` — sugar over `append` for event-role
    messages
  - `useOnEntry(filter, handler)` / `useOnEvent(type?, handler)` — primitive
    timeline notification hooks (commit-time)

  **Skills (`@agentick/core/skill`):**

  - `defineSkill` / `loadSkill` / `parseSkill` — strict-spec programmatic factory
    - folder-based and flat-file loaders
  - `app.skills` — `SkillRegistry` on every app: `register` / `replace` / `get` /
    `has` / `list` / `unregister` / `clear` / `search` / `subscribe` / `loadDir`
  - `session.skill(name | def, { args, result?, maxTicks? })` — typed
    sub-execution. Caller-provided `result` schema becomes a transient `submit`
    tool the model fills with the typed answer
  - Implicit `skill` tool — auto-mounted when `app.skills` is non-empty; dynamic
    description lists registered skills; handler renders the body (with
    substitution and shell injection) and returns it as the tool result (the spec's
    load-into-context model)
  - `$ARGUMENTS` / `$N` / `$ARGUMENTS[N]` / `$name` / `${VARS}` substitution
  - `` !`<command>` `` and ` `! ```block shell injection — runs through`session.shell` so injections share the agent's sandbox
  - YAML frontmatter via the `yaml` package — full YAML 1.2 (block arrays,
    multiline strings, nested objects)

  **Spec compliance:**

  - Agent Skills open spec: strict `name` regex, `description` ≤1024 chars,
    `license`, `compatibility`, `metadata` (`Record<string, string>`),
    `allowed-tools`, parent-directory name match for folder-loaded skills
  - Claude Code extensions parsed: `when_to_use`, `argument-hint`, `arguments`,
    `disable-model-invocation`, `user-invocable`
  - Reserved Claude Code fields (`model`, `effort`, `context: fork`, `agent`,
    `hooks`, `paths`, `shell`) documented as TODO in
    `packages/core/src/skill/skill.ts` with implementation notes per phase

  **Docs:** new `/docs/agent-harness` and `/docs/skills` pages;
  `sessions-and-execution.md` and `packages.md` cross-updated.

  - @agentick/kernel@0.14.59
  - @agentick/shared@0.14.59
  - @agentick/mcp@0.14.59

## 0.14.58

### Patch Changes

- Updated dependencies [550d441]
  - @agentick/mcp@0.14.58
  - @agentick/kernel@0.14.58
  - @agentick/shared@0.14.58

## 0.14.57

### Patch Changes

- Updated dependencies [a6558cd]
  - @agentick/mcp@0.14.57
  - @agentick/kernel@0.14.57
  - @agentick/shared@0.14.57

## 0.14.56

### Patch Changes

- Updated dependencies [bc975a2]
  - @agentick/kernel@0.14.56
  - @agentick/mcp@0.14.56
  - @agentick/shared@0.14.56

## 0.14.55

### Patch Changes

- 9a7d6ff: docs update
- Updated dependencies [9a7d6ff]
  - @agentick/mcp@0.14.55
  - @agentick/shared@0.14.55
  - @agentick/kernel@0.14.55

## 0.14.54

### Patch Changes

- @agentick/kernel@0.14.54
- @agentick/shared@0.14.54
- @agentick/mcp@0.14.54

## 0.14.53

### Patch Changes

- d665fd6: support thought signatures
- Updated dependencies [d665fd6]
  - @agentick/shared@0.14.53
  - @agentick/kernel@0.14.53
  - @agentick/mcp@0.14.53

## 0.14.52

### Patch Changes

- Updated dependencies [999d640]
  - @agentick/mcp@0.14.52
  - @agentick/kernel@0.14.52
  - @agentick/shared@0.14.52

## 0.14.51

### Patch Changes

- 152943e: fix package exports for default imports
- Updated dependencies [152943e]
  - @agentick/kernel@0.14.51
  - @agentick/mcp@0.14.51
  - @agentick/shared@0.14.51

## 0.14.50

### Patch Changes

- Updated dependencies [6e231ac]
  - @agentick/mcp@0.14.50
  - @agentick/kernel@0.14.50
  - @agentick/shared@0.14.50

## 0.14.49

### Patch Changes

- Updated dependencies [0bba30e]
  - @agentick/kernel@0.14.49
  - @agentick/mcp@0.14.49
  - @agentick/shared@0.14.49

## 0.14.48

### Patch Changes

- 472821b: append sections to system
  - @agentick/kernel@0.14.48
  - @agentick/shared@0.14.48
  - @agentick/mcp@0.14.48

## 0.14.47

### Patch Changes

- ff7a627: enhanced mcp server
- Updated dependencies [ff7a627]
  - @agentick/mcp@0.14.47
  - @agentick/kernel@0.14.47
  - @agentick/shared@0.14.47

## 0.14.46

### Patch Changes

- bfa93be: mcp component to connect to mcp client in useData not useEffect
  - @agentick/kernel@0.14.46
  - @agentick/shared@0.14.46
  - @agentick/mcp@0.14.46

## 0.14.45

### Patch Changes

- fbeae6c: client fixes
- Updated dependencies [fbeae6c]
  - @agentick/mcp@0.14.45
  - @agentick/kernel@0.14.45
  - @agentick/shared@0.14.45

## 0.14.44

### Patch Changes

- 61c0735: mcp client aligns with oauth connection spec and flow, fix mcp tools
- Updated dependencies [61c0735]
  - @agentick/mcp@0.14.44
  - @agentick/kernel@0.14.44
  - @agentick/shared@0.14.44

## 0.14.43

### Patch Changes

- dcf946a: client enhancements
- Updated dependencies [dcf946a]
  - @agentick/mcp@0.14.43
  - @agentick/kernel@0.14.43
  - @agentick/shared@0.14.43

## 0.14.42

### Patch Changes

- @agentick/kernel@0.14.42
- @agentick/shared@0.14.42
- @agentick/mcp@0.14.42

## 0.14.41

### Patch Changes

- 86f043a: schema type detection
  - @agentick/kernel@0.14.41
  - @agentick/shared@0.14.41
  - @agentick/mcp@0.14.41

## 0.14.40

### Patch Changes

- Updated dependencies [5c267b0]
  - @agentick/mcp@0.14.40
  - @agentick/kernel@0.14.40
  - @agentick/shared@0.14.40

## 0.14.39

### Patch Changes

- @agentick/kernel@0.14.39
- @agentick/shared@0.14.39
- @agentick/mcp@0.14.39

## 0.14.38

### Patch Changes

- Updated dependencies [462f1d3]
  - @agentick/mcp@0.14.38
  - @agentick/kernel@0.14.38
  - @agentick/shared@0.14.38

## 0.14.37

### Patch Changes

- Updated dependencies [f919c8b]
  - @agentick/mcp@0.14.37
  - @agentick/kernel@0.14.37
  - @agentick/shared@0.14.37

## 0.14.36

### Patch Changes

- e4aa633: mcp apps host integration
- Updated dependencies [e4aa633]
  - @agentick/mcp@0.14.36
  - @agentick/kernel@0.14.36
  - @agentick/shared@0.14.36

## 0.14.35

### Patch Changes

- @agentick/kernel@0.14.35
- @agentick/shared@0.14.35
- @agentick/mcp@0.14.35

## 0.14.34

### Patch Changes

- Updated dependencies [89d704c]
  - @agentick/mcp@0.14.34
  - @agentick/kernel@0.14.34
  - @agentick/shared@0.14.34

## 0.14.33

### Patch Changes

- @agentick/kernel@0.14.33
- @agentick/shared@0.14.33
- @agentick/mcp@0.14.33

## 0.14.32

### Patch Changes

- Updated dependencies [ba21889]
  - @agentick/mcp@0.14.32
  - @agentick/kernel@0.14.32
  - @agentick/shared@0.14.32

## 0.14.31

### Patch Changes

- @agentick/kernel@0.14.31
- @agentick/shared@0.14.31
- @agentick/mcp@0.14.31

## 0.14.30

### Patch Changes

- 29ddb7a: Renderer fix
- Updated dependencies [3ad42aa]
  - @agentick/mcp@0.14.30
  - @agentick/kernel@0.14.30
  - @agentick/shared@0.14.30

## 0.14.29

### Patch Changes

- d8b1984: Introduce standalone `@agentick/mcp` package and migrate core + gateway to use it.

  **New package: `@agentick/mcp`**

  A standalone MCP (Model Context Protocol) server and client library that depends only on `@agentick/kernel` and `@agentick/shared`. Drop it into any project — no core, no gateway, no framework coupling.

  - `MCPServer` — per-session SDK `Server` pool, shared registry, dynamic tool/resource/prompt registration with notification fan-out (`tools/list_changed`, `resources/list_changed`), structured error sanitization, request-level security pipeline
  - `MCPClient` — multi-server connection pool, tool/resource/prompt caching, automatic cache invalidation on notifications, progress callbacks, sampling and roots support, logging, completions, cancellation
  - Security pipeline — `ConnectionGuard → contextProvider → Authenticator → Authorizer → RateLimiter → InputSanitizer`, fully pluggable with safe defaults
  - MCP Apps (local variant) — `createMCPApp` wraps ext-apps `AppBridge` + `PostMessageTransport`, enforces tool visibility from `_meta.ui.visibility`, exposes `buildAllowAttribute` / `getToolAppUri` / `isToolVisibilityModelOnly` helpers
  - 158 tests covering server, client, security, protocol, transport integration, and HTTP lifecycle

  **Core migration (`@agentick/core`)**

  `packages/core/src/mcp/client.ts` is now a thin adapter over `@agentick/mcp`'s `MCPClient`. Existing core consumers see the same public API (`MCPClient`, `MCPService`, `MCPTool`, `MCPResourceComponent`) with unchanged behavior. Net `-564` lines in `packages/core/src/mcp/`.

  **Gateway migration (`@agentick/gateway`)**

  `mcpServerPlugin` now delegates entirely to `@agentick/mcp`'s `MCPServer`. The plugin is auth-agnostic (gateway middleware handles auth, MCP server trusts), supports tool catalog discovery, standalone tools, static resources, resource templates, per-session filtering, and OAuth metadata proxying. Public plugin config types (`MCPStaticResource`, `MCPResourceTemplate`, `MCPStandaloneTool`, `MCPServerPluginConfig`, `ToolEntry`) are unchanged. Net `-471` lines in `packages/gateway/src/plugins/mcp-server.ts`.

  **SDK version bump**

  `@modelcontextprotocol/sdk` bumped `^1.26.0 → ^1.29.0` in `@agentick/core` and `@agentick/gateway`. Required by `@modelcontextprotocol/ext-apps@1.5.0`, which `@agentick/mcp` uses for the MCP Apps bridge.

  **Deferred**

  - `createMCPAppRelay` — server-side AppBridge variant for bridging an iframe over a remote chat channel. Required for cloud-agent + browser-UI topology. Blocked on agentick's bidirectional channel architecture resolving (see `docs/channels-current-state.md`). The local `createMCPApp` variant ships today and covers in-process and desktop-local use cases.
  - `MCPAuthProvider` — pluggable OAuth 2.1 / DCR / token refresh. Phase 5 work item; not architecturally blocked.

- Updated dependencies [d8b1984]
  - @agentick/mcp@0.14.29
  - @agentick/kernel@0.14.29
  - @agentick/shared@0.14.29

## 0.14.28

### Patch Changes

- @agentick/kernel@0.14.28
- @agentick/shared@0.14.28

## 0.14.27

### Patch Changes

- @agentick/kernel@0.14.27
- @agentick/shared@0.14.27

## 0.14.26

### Patch Changes

- @agentick/kernel@0.14.26
- @agentick/shared@0.14.26

## 0.14.25

### Patch Changes

- b602b9b: feat(mcp): unified `<MCP>` component with progressive resource discovery

  New `<MCP>` component connects to MCP servers and provides both tools and resources. Tools are registered per-server. Resources are unified under `list_resources` and `read_resource` tools across all servers.

  - `MCPClient`: resource discovery (`listResources`, `readResource`, `listResourceTemplates`), URI routing (`readResourceByURI`), cache invalidation
  - `MCPResourceComponent`: terrain map in context + progressive resource tools
  - `MCPComponent` (`<MCP>`): single component for tools + resources with shared client
  - Exported from `"agentick"`: `MCP`, `MCPClient`, `MCPConfig`, `MCPResource`, etc.
  - @agentick/kernel@0.14.25
  - @agentick/shared@0.14.25

## 0.14.24

### Patch Changes

- @agentick/kernel@0.14.24
- @agentick/shared@0.14.24

## 0.14.23

### Patch Changes

- @agentick/kernel@0.14.23
- @agentick/shared@0.14.23

## 0.14.22

### Patch Changes

- @agentick/kernel@0.14.22
- @agentick/shared@0.14.22

## 0.14.21

### Patch Changes

- @agentick/kernel@0.14.21
- @agentick/shared@0.14.21

## 0.14.20

### Patch Changes

- @agentick/kernel@0.14.20
- @agentick/shared@0.14.20

## 0.14.19

### Patch Changes

- @agentick/kernel@0.14.19
- @agentick/shared@0.14.19

## 0.14.18

### Patch Changes

- @agentick/kernel@0.14.18
- @agentick/shared@0.14.18

## 0.14.17

### Patch Changes

- @agentick/kernel@0.14.17
- @agentick/shared@0.14.17

## 0.14.16

### Patch Changes

- 59a9281: fortify model stream events
  - @agentick/kernel@0.14.16
  - @agentick/shared@0.14.16

## 0.14.15

### Patch Changes

- @agentick/kernel@0.14.15
- @agentick/shared@0.14.15

## 0.14.14

### Patch Changes

- @agentick/kernel@0.14.14
- @agentick/shared@0.14.14

## 0.14.13

### Patch Changes

- @agentick/kernel@0.14.13
- @agentick/shared@0.14.13

## 0.14.12

### Patch Changes

- 04451f0: ensure all adapters emit streaming tool call events
  - @agentick/kernel@0.14.12
  - @agentick/shared@0.14.12

## 0.14.11

### Patch Changes

- @agentick/kernel@0.14.11
- @agentick/shared@0.14.11

## 0.14.10

### Patch Changes

- @agentick/kernel@0.14.10
- @agentick/shared@0.14.10

## 0.14.9

### Patch Changes

- @agentick/kernel@0.14.9
- @agentick/shared@0.14.9

## 0.14.8

### Patch Changes

- @agentick/kernel@0.14.8
- @agentick/shared@0.14.8

## 0.14.7

### Patch Changes

- @agentick/kernel@0.14.7
- @agentick/shared@0.14.7

## 0.14.6

### Patch Changes

- 6b72302: fix: add "default" export condition to publishConfig exports

  Node's CJS resolver needs "default" or "require" in the exports map. Without it, require() throws ERR_PACKAGE_PATH_NOT_EXPORTED. Fixes intermittent crashes when nx's node executor loads packages via require().

- Updated dependencies [6b72302]
  - @agentick/kernel@0.14.6
  - @agentick/shared@0.14.6

## 0.14.5

### Patch Changes

- Updated dependencies [d0e35be]
  - @agentick/shared@0.14.5
  - @agentick/kernel@0.14.5

## 0.14.4

### Patch Changes

- cc1ee21: fix: useData fetcher rejection no longer causes infinite render loop

  When a useData fetcher rejected, the rejected promise stayed in
  pendingFetches forever (the .then cleanup never ran). This caused the
  compiler's render loop to retry indefinitely — storeHasPendingData
  returned true, storeResolvePendingData rejected, and the cycle repeated.

  Now the rejection handler caches the error with a sentinel value and
  cleans up pendingFetches. On re-render, the cached error is re-thrown
  synchronously (not as a promise), so the compiler loop exits cleanly.
  When deps change, the cache invalidates and a fresh fetch is attempted.

  Also changed storeResolvePendingData to use Promise.allSettled so one
  failing fetch doesn't block other concurrent fetches from resolving.

  - @agentick/kernel@0.14.4
  - @agentick/shared@0.14.4

## 0.14.3

### Patch Changes

- @agentick/kernel@0.14.3
- @agentick/shared@0.14.3

## 0.14.2

### Patch Changes

- @agentick/kernel@0.14.2
- @agentick/shared@0.14.2

## 0.14.1

### Patch Changes

- @agentick/kernel@0.14.1
- @agentick/shared@0.14.1

## 0.14.0

### Patch Changes

- @agentick/kernel@0.14.0
- @agentick/shared@0.14.0

## 0.13.2

### Patch Changes

- @agentick/kernel@0.13.2
- @agentick/shared@0.13.2

## 0.13.1

### Patch Changes

- @agentick/kernel@0.13.1
- @agentick/shared@0.13.1

## 0.13.0

### Minor Changes

- 8e568d1: Unified EmbedInput API and embed support on adapters
  - **EmbedInput**: New single-object input shape (`{ input, model?, dimensions?, taskType? }`) mirroring ModelInput style. Replaces previous `(texts, options)` positional params.
  - **embed as Procedure**: `EngineModel.embed` is now a Procedure with middleware, ALS context, and telemetry support.
  - **OpenAI adapter**: Added `embeddingModel` config option and `embed()` support via OpenAI embeddings API.
  - **Google adapter**: Added `embeddingModel` config option and `embed()` support via Google embedContent API, including `dimensions` and `taskType` passthrough.
  - **Per-request model override**: API adapters (OpenAI, Google) respect `input.model` to override the configured embedding model per-request.
  - **Custom XML tag passthrough**: Collector and markdown renderer now pass through unrecognized XML tags as custom blocks.

### Patch Changes

- Updated dependencies [8e568d1]
  - @agentick/shared@0.13.0
  - @agentick/kernel@0.13.0

## 0.12.3

### Patch Changes

- Updated dependencies [badc15b]
  - @agentick/kernel@0.12.3
  - @agentick/shared@0.12.3

## 0.12.2

### Patch Changes

- @agentick/kernel@0.12.2
- @agentick/shared@0.12.2

## 0.12.1

### Patch Changes

- @agentick/kernel@0.12.1
- @agentick/shared@0.12.1

## 0.12.0

### Minor Changes

- 2435355: **Breaking**: `TransportEventData` no longer spreads `data` into the top level. Event payloads are now in a structured `data` field.

  Before: `{ type: "content_delta", sessionId: "main", text: "hello", index: 0 }`
  After: `{ type: "content_delta", sessionId: "main", data: { text: "hello", index: 0 } }`

  The `[key: string]: unknown` index signature is removed. This prevents silent property collisions between envelope fields (`type`, `sessionId`) and payload properties, and makes `TransportEventData` a proper typed interface rather than a bag.

  `unwrapEventMessage()` return type changed from `Record<string, unknown>` to `TransportEventData | Record<string, unknown>`.

  **Migration**: Any code accessing payload properties directly on transport events (e.g., `event.delta`, `event.text`) must now access them through `event.data` (e.g., `(event.data as StreamEvent).delta`).

### Patch Changes

- Updated dependencies [2435355]
  - @agentick/shared@0.12.0
  - @agentick/kernel@0.12.0

## 0.11.2

### Patch Changes

- 6d169a8: Expose `sessionId` on COM so tool handlers can access their owning session's ID via `ctx.sessionId`. Returns null in test contexts without session wiring.
  - @agentick/kernel@0.11.2
  - @agentick/shared@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [336c439]
  - @agentick/shared@0.11.1
  - @agentick/kernel@0.11.1

## 0.11.0

### Minor Changes

- 10023a7: ### Cache metrics & CacheHealth widget

  - Surface `cachedInputTokens`, `cacheCreationTokens`, and `cacheHitRatio` through ContextInfo, protocol payloads, streaming events, and devtools
  - New `CacheHealth` status bar widget with configurable color thresholds

  ### Shell → Bash rename

  - Rename Shell tool to Bash across sandbox packages
  - Fix base executor to use `bash -c` instead of `sh -c` (enables brace expansion)

  ### Mode-aware mount consolidation

  - `addMount()` now respects mount modes: rw parents consume all children, ro parents only consume ro children
  - Redundant child mounts skipped when parent already covers them
  - Mode promotion (ro → rw) on exact path match
  - Confirmation messages show the directory being mounted, not the individual file

  ### useEvents batching fix

  - Replace single-event useState with microtask-batched queue to prevent React state batching from dropping events

  ### Empty response guard

  - Detect empty model responses and replace with corrective event instead of persisting empty assistant messages

  ### Gateway logging

  - Debug/trace logging for RPC requests, event streaming, and send method flow
  - Logging config (level, file) in gateway FileConfig

### Patch Changes

- Updated dependencies [10023a7]
  - @agentick/shared@0.11.0
  - @agentick/kernel@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [84a0400]
  - @agentick/shared@0.10.1
  - @agentick/kernel@0.10.1

## 0.10.0

### Patch Changes

- 619c448: Formalize gateway protocol with full schema discovery

  Phase 1 — Protocol foundation:

  - Add `protocolVersion` to ConnectMessage/ConnectedMessage handshake
  - Send ConnectedMessage on WebSocket and Unix socket auth completion
  - New built-in methods: `schema`, `tool-catalog`, `tool-confirm`, `tool-dispatch`
  - Add `audience` field to ToolDefinition (shared)
  - Add `getToolDefinitions()` to Session interface (core)

  Phase 2 — Complete schema discovery:

  - `schema` method returns full protocol contract: every method with JSON Schema
    for params and response, every event type with category, every error code
  - Extract `MODEL_EVENT_TYPES`, `ORCHESTRATION_EVENT_TYPES`, `RESULT_EVENT_TYPES`
    from shared (zero-maintenance event catalog)
  - Structured error codes using shared's error hierarchy (`isNotFoundError`,
    `isGuardError`, etc.) instead of catch-all `METHOD_ERROR`
  - Custom method `response` schema support via `MethodDefinitionInput.response`
  - Breaking: `SchemaPayload` shape changed — unified `methods` record replaces
    `builtInMethods`/`customMethods` split (no external consumers yet)

- Updated dependencies [619c448]
  - @agentick/shared@0.10.0
  - @agentick/kernel@0.10.0

## 0.9.6

### Patch Changes

- 84752df: Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.
- Updated dependencies [84752df]
  - @agentick/kernel@0.9.6
  - @agentick/shared@0.9.6

## 0.9.5

### Patch Changes

- dc26053: Add `session.pushEvent(event)` to the public Session interface. Injects an event into a session's event stream with full enrichment (id, tick, timestamp, sequence, devtools forwarding). Enables external event routing between sessions not connected via spawn.
  - @agentick/kernel@0.9.5
  - @agentick/shared@0.9.5

## 0.9.4

### Patch Changes

- @agentick/kernel@0.9.4
- @agentick/shared@0.9.4

## 0.9.3

### Patch Changes

- 1a4c9b0: Switch root tsconfig from `jsx: "preserve"` to `jsx: "react-jsx"` so tsc emits `.js` files instead of `.jsx`. Node's module resolver doesn't look for `.jsx` extensions, causing `ERR_MODULE_NOT_FOUND` at runtime for any package with `.tsx` source files.
  - @agentick/kernel@0.9.3
  - @agentick/shared@0.9.3

## 0.9.2

### Patch Changes

- Updated dependencies [7b45b0d]
  - @agentick/kernel@0.9.2
  - @agentick/shared@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1
  - @agentick/kernel@0.9.1

## 0.9.0

### Minor Changes

- d3f9b8d: feat: embeddings, gateway plugins, unix socket transport
  - Shared: embeddings types (`EmbeddingProvider`), `splitMessage` utility
  - Core: embedding support on adapters and engine models, `entry_committed` event, `executionId` on TickState
  - Gateway: plugin system with lifecycle management, Unix socket transport with shared RPC factory
  - Connector: re-export `splitMessage` from shared
  - Connector-telegram: rewrite as GatewayPlugin
  - Apple: embedding support via Apple Intelligence
  - Huggingface: new adapter for local embeddings via Transformers.js
  - Agentick: re-export `jsx-runtime` and `jsx-dev-runtime` from core
  - Fix: sub-path exports in publishConfig, Procedure wrapping for Tool handler

### Patch Changes

- Updated dependencies [d3f9b8d]
  - @agentick/shared@0.9.0
  - @agentick/kernel@0.9.0

## 0.8.0

### Patch Changes

- @agentick/kernel@0.8.0
- @agentick/shared@0.8.0

## 0.7.0

### Minor Changes

- c73753e: Sync all packages to 0.7.0.

  **Connector system** — New `@agentick/connector` package with platform integration primitives. Initial adapters for iMessage and Telegram.

  **CompletionSource redesign** — `@agentick/client` CompletionSource API uses match/resolve pattern.

  **MessageSource registry** — Typed message provenance tracking in `@agentick/shared`, used by connectors.

  **Gateway fix** — Re-resolve closed sessions after idle eviction.

  **Content blocks fix** — Pass all content block types through DefaultPendingMessage.

  **Testing utilities** — `createMockClient()` decoupled from vitest. Pass `vi.fn` or `jest.fn` as `fn` parameter for spy-wrapped methods.

  **Knobs documentation** — Accordion pattern for conditional context rendering.

### Patch Changes

- @agentick/kernel@0.7.0
- @agentick/shared@0.7.0

## 0.6.0

### Minor Changes

- 4750f5e: Tool call summaries and file confirmation with diff preview.

  Tools can define `displaySummary` to provide a short description (e.g., file
  path, command) that appears in stream events and TUI indicators.

  File modification tools (`write_file`, `edit_file`) now require confirmation
  before execution. A new `confirmationPreview` hook computes a unified diff
  that renders in the TUI confirmation prompt.

  Fixed: session confirmation channel wiring (was previously unconnected).

### Patch Changes

- e30960c: Auto-resume session on send when session exists but is not running.
- Updated dependencies [4750f5e]
  - @agentick/shared@0.6.0
  - @agentick/kernel@0.6.0

## 0.5.0

### Minor Changes

- 156bc2f: feat: add momentary knobs + useOnExecutionEnd lifecycle hook

  Momentary knobs (`knob.momentary()`) auto-reset to default at the end of each execution.
  Use case: lazy-loaded context that the model expands on demand, with automatic token reclamation.

  New lifecycle hook: `useOnExecutionEnd(cb)` fires after the tick loop but before snapshot persistence.

  fix: fire useOnTickStart on mount tick via catch-up mechanism

  `useOnTickStart` now fires on every tick the component is alive, including the mount tick. Previously, callbacks registered during `useEffect` in `flushSyncWork()` missed the initial `notifyTickStart()`.

  refactor: rename ExecutionRunner.prepareModelInput → transformCompiled

  The runner hook now operates on `COMInput` (rich semantic structure) before `fromEngineState` flattens it to `ModelInput`, giving runners access to system messages, sections, timeline, and tools as separate semantic concepts.

  feat(tui): InputBar controlled mode, delta timeline, activity indicator support

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/kernel@0.4.0
  - @agentick/shared@0.4.0

## 0.3.0

### Minor Changes

- d38460c: Add ExecutionRunner, SessionRef, SpawnOptions, async close()
  - ExecutionRunner interface with 6 optional hooks: prepareModelInput, executeToolCall, onSessionInit, onPersist, onRestore, onDestroy
  - SessionRef narrow interface for runner lifecycle hooks (avoids generic type friction)
  - SpawnOptions (3rd arg to session.spawn()) for overriding model, runner, maxTicks
  - session.close() is now async (Promise<void>) — properly awaits onDestroy, child closes, compiler unmount
  - createTestRunner() with function interceptor support in @agentick/core/testing
  - Dead code cleanup: removed obsolete streaming accumulation and processStream from EngineModel

## 0.2.1

### Patch Changes

- 07b630c: Upgrade to React 19 and react-reconciler 0.33. useComState now uses useSyncExternalStore for correct external state synchronization. Clean up dead code from reconciler migration.
- Updated dependencies [07b630c]
  - @agentick/kernel@0.2.1
  - @agentick/shared@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/kernel@0.2.0
  - @agentick/shared@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/kernel@0.1.9
  - @agentick/shared@0.1.9
