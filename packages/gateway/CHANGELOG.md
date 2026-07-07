# @agentick/gateway

## 0.15.2

### Patch Changes

- Updated dependencies [60ed478]
  - @agentick/core@0.15.2
  - @agentick/kernel@0.15.2
  - @agentick/shared@0.15.2
  - @agentick/server@0.15.2
  - @agentick/mcp@0.15.2

## 0.15.1

### Patch Changes

- @agentick/kernel@0.15.1
- @agentick/shared@0.15.1
- @agentick/core@0.15.1
- @agentick/server@0.15.1
- @agentick/mcp@0.15.1

## 0.15.0

### Minor Changes

- 45b99a7: Propagate tool `outputSchema` end-to-end when serving MCP. Tools defined with `createTool({ output })` now expose their output schema on `tools/list`, and `MCPServer` emits `outputSchema` for any `MCPToolDefinition` that declares one. The gateway's `tool-catalog` method gained an optional `output` field on each entry, and the `mcpServerPlugin` forwards it (along with a new `outputSchema` field on `MCPStandaloneTool`) into the registered `MCPToolDefinition`. JSON Schema conversion is shared via a new internal `toToolJSONSchema` helper, so input and output schemas go through the same Zod→draft-07 path.

### Patch Changes

- Updated dependencies [45b99a7]
- Updated dependencies [eca7b3c]
  - @agentick/mcp@0.15.0
  - @agentick/core@0.15.0
  - @agentick/kernel@0.15.0
  - @agentick/shared@0.15.0
  - @agentick/server@0.15.0

## 0.14.68

### Patch Changes

- @agentick/kernel@0.14.68
- @agentick/shared@0.14.68
- @agentick/core@0.14.68
- @agentick/server@0.14.68
- @agentick/mcp@0.14.68

## 0.14.67

### Patch Changes

- Updated dependencies [c753f82]
  - @agentick/core@0.14.67
  - @agentick/kernel@0.14.67
  - @agentick/shared@0.14.67
  - @agentick/server@0.14.67
  - @agentick/mcp@0.14.67

## 0.14.66

### Patch Changes

- Updated dependencies [35d7370]
  - @agentick/core@0.14.66
  - @agentick/kernel@0.14.66
  - @agentick/shared@0.14.66
  - @agentick/server@0.14.66
  - @agentick/mcp@0.14.66

## 0.14.65

### Patch Changes

- Updated dependencies [3483cbf]
  - @agentick/core@0.14.65
  - @agentick/kernel@0.14.65
  - @agentick/shared@0.14.65
  - @agentick/server@0.14.65
  - @agentick/mcp@0.14.65

## 0.14.64

### Patch Changes

- Updated dependencies [71ce3e0]
  - @agentick/core@0.14.64
  - @agentick/kernel@0.14.64
  - @agentick/shared@0.14.64
  - @agentick/server@0.14.64
  - @agentick/mcp@0.14.64

## 0.14.63

### Patch Changes

- Updated dependencies [009aa12]
  - @agentick/shared@0.14.63
  - @agentick/core@0.14.63
  - @agentick/kernel@0.14.63
  - @agentick/mcp@0.14.63
  - @agentick/server@0.14.63

## 0.14.62

### Patch Changes

- Updated dependencies [eb148b9]
  - @agentick/kernel@0.14.62
  - @agentick/core@0.14.62
  - @agentick/mcp@0.14.62
  - @agentick/server@0.14.62
  - @agentick/shared@0.14.62

## 0.14.61

### Patch Changes

- Updated dependencies [02afae6]
  - @agentick/kernel@0.14.61
  - @agentick/core@0.14.61
  - @agentick/mcp@0.14.61
  - @agentick/server@0.14.61
  - @agentick/shared@0.14.61

## 0.14.60

### Patch Changes

- c23d3d1: add dispatchProcedure for one off dispatch of function as procedure and refactor Context.create to Context.child
- Updated dependencies [c23d3d1]
  - @agentick/core@0.14.60
  - @agentick/kernel@0.14.60
  - @agentick/mcp@0.14.60
  - @agentick/server@0.14.60
  - @agentick/shared@0.14.60

## 0.14.59

### Patch Changes

- Updated dependencies [1cdc0a3]
  - @agentick/core@0.14.59
  - @agentick/kernel@0.14.59
  - @agentick/shared@0.14.59
  - @agentick/server@0.14.59
  - @agentick/mcp@0.14.59

## 0.14.58

### Patch Changes

- Updated dependencies [550d441]
  - @agentick/mcp@0.14.58
  - @agentick/kernel@0.14.58
  - @agentick/core@0.14.58
  - @agentick/server@0.14.58
  - @agentick/shared@0.14.58

## 0.14.57

### Patch Changes

- Updated dependencies [a6558cd]
  - @agentick/mcp@0.14.57
  - @agentick/core@0.14.57
  - @agentick/kernel@0.14.57
  - @agentick/shared@0.14.57
  - @agentick/server@0.14.57

## 0.14.56

### Patch Changes

- Updated dependencies [bc975a2]
  - @agentick/kernel@0.14.56
  - @agentick/mcp@0.14.56
  - @agentick/core@0.14.56
  - @agentick/server@0.14.56
  - @agentick/shared@0.14.56

## 0.14.55

### Patch Changes

- Updated dependencies [9a7d6ff]
  - @agentick/core@0.14.55
  - @agentick/mcp@0.14.55
  - @agentick/shared@0.14.55
  - @agentick/kernel@0.14.55
  - @agentick/server@0.14.55

## 0.14.54

### Patch Changes

- @agentick/kernel@0.14.54
- @agentick/shared@0.14.54
- @agentick/core@0.14.54
- @agentick/server@0.14.54
- @agentick/mcp@0.14.54

## 0.14.53

### Patch Changes

- Updated dependencies [d665fd6]
  - @agentick/core@0.14.53
  - @agentick/shared@0.14.53
  - @agentick/kernel@0.14.53
  - @agentick/mcp@0.14.53
  - @agentick/server@0.14.53

## 0.14.52

### Patch Changes

- Updated dependencies [999d640]
  - @agentick/mcp@0.14.52
  - @agentick/core@0.14.52
  - @agentick/kernel@0.14.52
  - @agentick/shared@0.14.52
  - @agentick/server@0.14.52

## 0.14.51

### Patch Changes

- 152943e: fix package exports for default imports
- Updated dependencies [152943e]
  - @agentick/core@0.14.51
  - @agentick/kernel@0.14.51
  - @agentick/mcp@0.14.51
  - @agentick/server@0.14.51
  - @agentick/shared@0.14.51

## 0.14.50

### Patch Changes

- 6e231ac: add toolTransform callback
- Updated dependencies [6e231ac]
  - @agentick/mcp@0.14.50
  - @agentick/core@0.14.50
  - @agentick/kernel@0.14.50
  - @agentick/shared@0.14.50
  - @agentick/server@0.14.50

## 0.14.49

### Patch Changes

- Updated dependencies [0bba30e]
  - @agentick/kernel@0.14.49
  - @agentick/mcp@0.14.49
  - @agentick/core@0.14.49
  - @agentick/server@0.14.49
  - @agentick/shared@0.14.49

## 0.14.48

### Patch Changes

- Updated dependencies [472821b]
  - @agentick/core@0.14.48
  - @agentick/kernel@0.14.48
  - @agentick/shared@0.14.48
  - @agentick/server@0.14.48
  - @agentick/mcp@0.14.48

## 0.14.47

### Patch Changes

- Updated dependencies [ff7a627]
  - @agentick/core@0.14.47
  - @agentick/mcp@0.14.47
  - @agentick/kernel@0.14.47
  - @agentick/shared@0.14.47
  - @agentick/server@0.14.47

## 0.14.46

### Patch Changes

- Updated dependencies [bfa93be]
  - @agentick/core@0.14.46
  - @agentick/kernel@0.14.46
  - @agentick/shared@0.14.46
  - @agentick/server@0.14.46
  - @agentick/mcp@0.14.46

## 0.14.45

### Patch Changes

- Updated dependencies [fbeae6c]
  - @agentick/core@0.14.45
  - @agentick/mcp@0.14.45
  - @agentick/kernel@0.14.45
  - @agentick/shared@0.14.45
  - @agentick/server@0.14.45

## 0.14.44

### Patch Changes

- Updated dependencies [61c0735]
  - @agentick/core@0.14.44
  - @agentick/mcp@0.14.44
  - @agentick/kernel@0.14.44
  - @agentick/shared@0.14.44
  - @agentick/server@0.14.44

## 0.14.43

### Patch Changes

- dcf946a: client enhancements
- Updated dependencies [dcf946a]
  - @agentick/core@0.14.43
  - @agentick/mcp@0.14.43
  - @agentick/kernel@0.14.43
  - @agentick/shared@0.14.43
  - @agentick/server@0.14.43

## 0.14.42

### Patch Changes

- @agentick/kernel@0.14.42
- @agentick/shared@0.14.42
- @agentick/core@0.14.42
- @agentick/server@0.14.42
- @agentick/mcp@0.14.42

## 0.14.41

### Patch Changes

- Updated dependencies [86f043a]
  - @agentick/core@0.14.41
  - @agentick/kernel@0.14.41
  - @agentick/shared@0.14.41
  - @agentick/server@0.14.41
  - @agentick/mcp@0.14.41

## 0.14.40

### Patch Changes

- 5c267b0: in-process transport + google tool normalization
- Updated dependencies [5c267b0]
  - @agentick/mcp@0.14.40
  - @agentick/core@0.14.40
  - @agentick/kernel@0.14.40
  - @agentick/shared@0.14.40
  - @agentick/server@0.14.40

## 0.14.39

### Patch Changes

- e2c073b: passthrough mcp tool and capability info
  - @agentick/kernel@0.14.39
  - @agentick/shared@0.14.39
  - @agentick/core@0.14.39
  - @agentick/server@0.14.39
  - @agentick/mcp@0.14.39

## 0.14.38

### Patch Changes

- Updated dependencies [462f1d3]
  - @agentick/mcp@0.14.38
  - @agentick/core@0.14.38
  - @agentick/kernel@0.14.38
  - @agentick/shared@0.14.38
  - @agentick/server@0.14.38

## 0.14.37

### Patch Changes

- Updated dependencies [f919c8b]
  - @agentick/mcp@0.14.37
  - @agentick/server@0.14.37
  - @agentick/core@0.14.37
  - @agentick/kernel@0.14.37
  - @agentick/shared@0.14.37

## 0.14.36

### Patch Changes

- e4aa633: mcp apps host integration
- Updated dependencies [e4aa633]
  - @agentick/core@0.14.36
  - @agentick/mcp@0.14.36
  - @agentick/kernel@0.14.36
  - @agentick/shared@0.14.36
  - @agentick/server@0.14.36

## 0.14.35

### Patch Changes

- 540d308: mcp server plugin accepts an mcp server
  - @agentick/kernel@0.14.35
  - @agentick/shared@0.14.35
  - @agentick/core@0.14.35
  - @agentick/server@0.14.35
  - @agentick/mcp@0.14.35

## 0.14.34

### Patch Changes

- Updated dependencies [89d704c]
  - @agentick/mcp@0.14.34
  - @agentick/core@0.14.34
  - @agentick/kernel@0.14.34
  - @agentick/shared@0.14.34
  - @agentick/server@0.14.34

## 0.14.33

### Patch Changes

- 2270099: support mcp apps in mcp server plugin
  - @agentick/kernel@0.14.33
  - @agentick/shared@0.14.33
  - @agentick/core@0.14.33
  - @agentick/server@0.14.33
  - @agentick/mcp@0.14.33

## 0.14.32

### Patch Changes

- Updated dependencies [ba21889]
  - @agentick/mcp@0.14.32
  - @agentick/server@0.14.32
  - @agentick/core@0.14.32
  - @agentick/kernel@0.14.32
  - @agentick/shared@0.14.32

## 0.14.31

### Patch Changes

- 8d96448: Close all active sessions on gateway shutdown, ensuring component unmount and sandbox teardown.
  - @agentick/kernel@0.14.31
  - @agentick/shared@0.14.31
  - @agentick/core@0.14.31
  - @agentick/server@0.14.31
  - @agentick/mcp@0.14.31

## 0.14.30

### Patch Changes

- Updated dependencies [29ddb7a]
- Updated dependencies [3ad42aa]
  - @agentick/core@0.14.30
  - @agentick/mcp@0.14.30
  - @agentick/kernel@0.14.30
  - @agentick/shared@0.14.30
  - @agentick/server@0.14.30

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
  - @agentick/core@0.14.29
  - @agentick/kernel@0.14.29
  - @agentick/shared@0.14.29
  - @agentick/server@0.14.29

## 0.14.28

### Patch Changes

- @agentick/kernel@0.14.28
- @agentick/shared@0.14.28
- @agentick/core@0.14.28
- @agentick/server@0.14.28

## 0.14.27

### Patch Changes

- @agentick/kernel@0.14.27
- @agentick/shared@0.14.27
- @agentick/core@0.14.27
- @agentick/server@0.14.27

## 0.14.26

### Patch Changes

- 3a15780: fix(gateway): handle stale MCP session IDs gracefully

  MCP clients (Cursor, etc.) may cache session IDs across server restarts. The MCP server plugin now detects stale session IDs paired with an `initialize` request and falls through to create a new session instead of returning 404. Also makes `GatewayPlugin.destroy()` optional.

  - @agentick/kernel@0.14.26
  - @agentick/shared@0.14.26
  - @agentick/core@0.14.26
  - @agentick/server@0.14.26

## 0.14.25

### Patch Changes

- b602b9b: feat(mcp): unified `<MCP>` component with progressive resource discovery

  New `<MCP>` component connects to MCP servers and provides both tools and resources. Tools are registered per-server. Resources are unified under `list_resources` and `read_resource` tools across all servers.

  - `MCPClient`: resource discovery (`listResources`, `readResource`, `listResourceTemplates`), URI routing (`readResourceByURI`), cache invalidation
  - `MCPResourceComponent`: terrain map in context + progressive resource tools
  - `MCPComponent` (`<MCP>`): single component for tools + resources with shared client
  - Exported from `"agentick"`: `MCP`, `MCPClient`, `MCPConfig`, `MCPResource`, etc.

- cbb2c1b: mcp tool updates
- Updated dependencies [b602b9b]
  - @agentick/core@0.14.25
  - @agentick/kernel@0.14.25
  - @agentick/shared@0.14.25
  - @agentick/server@0.14.25

## 0.14.24

### Patch Changes

- 092d470: better mcp oauth support
  - @agentick/kernel@0.14.24
  - @agentick/shared@0.14.24
  - @agentick/core@0.14.24
  - @agentick/server@0.14.24

## 0.14.23

### Patch Changes

- c191c6b: fix multiple mcp clients bug
  - @agentick/kernel@0.14.23
  - @agentick/shared@0.14.23
  - @agentick/core@0.14.23
  - @agentick/server@0.14.23

## 0.14.22

### Patch Changes

- 9cd37df: add support for protected resource discovery in mcp plugin
- Updated dependencies [9cd37df]
  - @agentick/server@0.14.22
  - @agentick/kernel@0.14.22
  - @agentick/shared@0.14.22
  - @agentick/core@0.14.22

## 0.14.21

### Patch Changes

- @agentick/kernel@0.14.21
- @agentick/shared@0.14.21
- @agentick/core@0.14.21
- @agentick/server@0.14.21

## 0.14.20

### Patch Changes

- 152ac52: add logging middleware
  - @agentick/kernel@0.14.20
  - @agentick/shared@0.14.20
  - @agentick/core@0.14.20
  - @agentick/server@0.14.20

## 0.14.19

### Patch Changes

- 8ad9d35: auth updates
  - @agentick/kernel@0.14.19
  - @agentick/shared@0.14.19
  - @agentick/core@0.14.19
  - @agentick/server@0.14.19

## 0.14.18

### Patch Changes

- 36fac24: feat: enhance mcp plugin auth
  - @agentick/kernel@0.14.18
  - @agentick/shared@0.14.18
  - @agentick/core@0.14.18
  - @agentick/server@0.14.18

## 0.14.17

### Patch Changes

- f27c004: client - improve types; gateway - improve mcp plugin
  - @agentick/kernel@0.14.17
  - @agentick/shared@0.14.17
  - @agentick/core@0.14.17
  - @agentick/server@0.14.17

## 0.14.16

### Patch Changes

- Updated dependencies [59a9281]
  - @agentick/core@0.14.16
  - @agentick/kernel@0.14.16
  - @agentick/shared@0.14.16
  - @agentick/server@0.14.16

## 0.14.15

### Patch Changes

- d08f1fe: prevent duplicate event send
  - @agentick/kernel@0.14.15
  - @agentick/shared@0.14.15
  - @agentick/core@0.14.15
  - @agentick/server@0.14.15

## 0.14.14

### Patch Changes

- 30a8174: auth and sandbox teardown
- Updated dependencies [30a8174]
  - @agentick/server@0.14.14
  - @agentick/kernel@0.14.14
  - @agentick/shared@0.14.14
  - @agentick/core@0.14.14

## 0.14.13

### Patch Changes

- @agentick/kernel@0.14.13
- @agentick/shared@0.14.13
- @agentick/core@0.14.13
- @agentick/server@0.14.13

## 0.14.12

### Patch Changes

- Updated dependencies [04451f0]
  - @agentick/core@0.14.12
  - @agentick/kernel@0.14.12
  - @agentick/shared@0.14.12
  - @agentick/server@0.14.12

## 0.14.11

### Patch Changes

- @agentick/kernel@0.14.11
- @agentick/shared@0.14.11
- @agentick/core@0.14.11
- @agentick/server@0.14.11

## 0.14.10

### Patch Changes

- @agentick/kernel@0.14.10
- @agentick/shared@0.14.10
- @agentick/core@0.14.10
- @agentick/server@0.14.10

## 0.14.9

### Patch Changes

- @agentick/kernel@0.14.9
- @agentick/shared@0.14.9
- @agentick/core@0.14.9
- @agentick/server@0.14.9

## 0.14.8

### Patch Changes

- @agentick/kernel@0.14.8
- @agentick/shared@0.14.8
- @agentick/core@0.14.8
- @agentick/server@0.14.8

## 0.14.7

### Patch Changes

- @agentick/kernel@0.14.7
- @agentick/shared@0.14.7
- @agentick/core@0.14.7
- @agentick/server@0.14.7

## 0.14.6

### Patch Changes

- Updated dependencies [6b72302]
  - @agentick/kernel@0.14.6
  - @agentick/shared@0.14.6
  - @agentick/core@0.14.6
  - @agentick/server@0.14.6

## 0.14.5

### Patch Changes

- Updated dependencies [d0e35be]
  - @agentick/shared@0.14.5
  - @agentick/core@0.14.5
  - @agentick/kernel@0.14.5
  - @agentick/server@0.14.5

## 0.14.4

### Patch Changes

- Updated dependencies [cc1ee21]
  - @agentick/core@0.14.4
  - @agentick/kernel@0.14.4
  - @agentick/shared@0.14.4
  - @agentick/server@0.14.4

## 0.14.3

### Patch Changes

- 1b13ab3: fix: authenticate and set ALS context once at the request boundary

  Moved auth validation and `Context.run()` to `handleRequest()` so all
  downstream handlers, session creation, plugin routes, and tool execution
  inherit the authenticated user automatically. Previously each handler
  validated auth independently, and `handleSend` never propagated the user
  to the ALS context — causing session stores to see `userId: "unknown"`.

  Also changed `this.session()` to use `Context.fork()` instead of
  `Context.create()` so it inherits the outer context (including user)
  when adding the gateway handle, rather than replacing it.

  - @agentick/kernel@0.14.3
  - @agentick/shared@0.14.3
  - @agentick/core@0.14.3
  - @agentick/server@0.14.3

## 0.14.2

### Patch Changes

- 4ee5ffe: fix: propagate authenticated user to ALS context in HTTP send handler

  The `handleSend` SSE endpoint validated auth but never set `authResult.user` on the kernel Context, so session stores and tools saw `userId: "unknown"`. Now wraps `directSend` in `Context.run()` with the authenticated user, matching what `handleInvoke` already does.

  - @agentick/kernel@0.14.2
  - @agentick/shared@0.14.2
  - @agentick/core@0.14.2
  - @agentick/server@0.14.2

## 0.14.1

### Patch Changes

- @agentick/kernel@0.14.1
- @agentick/shared@0.14.1
- @agentick/core@0.14.1
- @agentick/server@0.14.1

## 0.14.0

### Patch Changes

- @agentick/kernel@0.14.0
- @agentick/shared@0.14.0
- @agentick/core@0.14.0
- @agentick/server@0.14.0

## 0.13.2

### Patch Changes

- @agentick/kernel@0.13.2
- @agentick/shared@0.13.2
- @agentick/core@0.13.2
- @agentick/server@0.13.2

## 0.13.1

### Patch Changes

- @agentick/kernel@0.13.1
- @agentick/shared@0.13.1
- @agentick/core@0.13.1
- @agentick/server@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [8e568d1]
  - @agentick/shared@0.13.0
  - @agentick/core@0.13.0
  - @agentick/kernel@0.13.0
  - @agentick/server@0.13.0

## 0.12.3

### Patch Changes

- badc15b: Fix EventBuffer dual-consumption bug where multiple async iterators on the same buffer caused duplicate and missed events. The shared waiter mechanism now wakes all iterators and each reads from the buffer at its own index.

  Gateway plugin routes now enforce auth by default. Plugins can opt out with `{ auth: false }`. Auth enforcement centralized in `dispatchPluginRoute()` covering both embedded and HTTP transport paths. Added `validateAuth()` to `PluginContext` for custom plugin auth logic.

- Updated dependencies [badc15b]
  - @agentick/kernel@0.12.3
  - @agentick/core@0.12.3
  - @agentick/server@0.12.3
  - @agentick/shared@0.12.3

## 0.12.2

### Patch Changes

- 17619ca: Add `toolFilter` option to `mcpServerPlugin` for per-session MCP tool filtering. When set, each MCP client handshake creates its own `McpServer` with tools filtered by a user-provided callback that receives `(ToolEntry[], IncomingMessage)`. Without `toolFilter`, behavior is unchanged. Export `ToolEntry` type as `McpToolEntry`.
  - @agentick/kernel@0.12.2
  - @agentick/shared@0.12.2
  - @agentick/core@0.12.2
  - @agentick/server@0.12.2

## Unreleased

### Minor Changes

- Add `toolFilter` option to `mcpServerPlugin` for per-session MCP tool filtering. When set, each MCP client handshake creates its own `McpServer` with tools filtered by a user-provided callback that receives the tool catalog and the raw `IncomingMessage`. Enables multi-user deployments where different clients see different tool sets based on auth headers. Without `toolFilter`, behavior is unchanged (single stateless `McpServer`).
- Export `ToolEntry` type (as `McpToolEntry`) and `filterTools` from the plugin module.

## 0.12.0

### Minor Changes

- 2435355: Add `broadcast(event, data)` to `PluginContext`. Plugins can push events to clients subscribed via synthetic `$plugin:{pluginId}` session keys. Subscribe/unsubscribe routing, disconnect cleanup, and plugin removal cleanup are all handled automatically.
- 2435355: **Breaking**: `TransportEventData` no longer spreads `data` into the top level. Event payloads are now in a structured `data` field.

  Before: `{ type: "content_delta", sessionId: "main", text: "hello", index: 0 }`
  After: `{ type: "content_delta", sessionId: "main", data: { text: "hello", index: 0 } }`

  The `[key: string]: unknown` index signature is removed. This prevents silent property collisions between envelope fields (`type`, `sessionId`) and payload properties, and makes `TransportEventData` a proper typed interface rather than a bag.

  `unwrapEventMessage()` return type changed from `Record<string, unknown>` to `TransportEventData | Record<string, unknown>`.

  **Migration**: Any code accessing payload properties directly on transport events (e.g., `event.delta`, `event.text`) must now access them through `event.data` (e.g., `(event.data as StreamEvent).delta`).

### Patch Changes

- Updated dependencies [2435355]
  - @agentick/shared@0.12.0
  - @agentick/core@0.12.0
  - @agentick/kernel@0.12.0
  - @agentick/server@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies [6d169a8]
  - @agentick/core@0.11.2
  - @agentick/kernel@0.11.2
  - @agentick/shared@0.11.2
  - @agentick/server@0.11.2

## 0.11.1

### Patch Changes

- 336c439: Fix tool-confirm RPC: correct method name (`tool-response` → `tool-confirm`), map field names (`toolUseId` → `callId`, `approved` → `confirmed`), and forward `always` flag through gateway so "Always Allow" works for remote clients.
- Updated dependencies [336c439]
  - @agentick/shared@0.11.1
  - @agentick/core@0.11.1
  - @agentick/kernel@0.11.1
  - @agentick/server@0.11.1

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
  - @agentick/core@0.11.0
  - @agentick/kernel@0.11.0
  - @agentick/server@0.11.0

## 0.10.1

### Patch Changes

- 84a0400: Pass full SendInput through WebSocket/Unix RPC transport

  The RPC transport was silently dropping multi-modal content by extracting
  plain text from SendInput before sending over the wire. Now the full
  SendInput (messages with ContentBlock arrays) passes through untouched.

  - SendParams accepts `input?: SendInput` (full multi-modal) alongside
    `message?: string` (text-only convenience shorthand)
  - Delete dead `attachments` field from SendParams
  - Delete `extractSendMessage` and helpers from transport-utils
  - Fix HistoryPayload.content type to `ContentBlock[] | string`

- Updated dependencies [84a0400]
  - @agentick/shared@0.10.1
  - @agentick/core@0.10.1
  - @agentick/kernel@0.10.1
  - @agentick/server@0.10.1

## 0.10.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [619c448]
  - @agentick/core@0.10.0
  - @agentick/shared@0.10.0
  - @agentick/kernel@0.10.0
  - @agentick/server@0.10.0

## 0.9.6

### Patch Changes

- 84752df: Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.
- Updated dependencies [84752df]
  - @agentick/core@0.9.6
  - @agentick/kernel@0.9.6
  - @agentick/shared@0.9.6
  - @agentick/server@0.9.6

## 0.9.5

### Patch Changes

- Updated dependencies [dc26053]
  - @agentick/core@0.9.5
  - @agentick/kernel@0.9.5
  - @agentick/shared@0.9.5
  - @agentick/server@0.9.5

## 0.9.4

### Patch Changes

- e01f0e5: Remove testing utility re-exports from main entrypoint to prevent vitest from being required at runtime. Testing utilities are available via `@agentick/gateway/testing` subpath import.
  - @agentick/kernel@0.9.4
  - @agentick/shared@0.9.4
  - @agentick/core@0.9.4
  - @agentick/server@0.9.4

## 0.9.3

### Patch Changes

- Updated dependencies [1a4c9b0]
  - @agentick/core@0.9.3
  - @agentick/kernel@0.9.3
  - @agentick/shared@0.9.3
  - @agentick/server@0.9.3

## 0.9.2

### Patch Changes

- Updated dependencies [7b45b0d]
  - @agentick/kernel@0.9.2
  - @agentick/core@0.9.2
  - @agentick/server@0.9.2
  - @agentick/shared@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1
  - @agentick/core@0.9.1
  - @agentick/kernel@0.9.1
  - @agentick/server@0.9.1

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
  - @agentick/core@0.9.0
  - @agentick/kernel@0.9.0
  - @agentick/server@0.9.0

## 0.8.0

### Minor Changes

- f84c8bb: Unified SSE wire format and event delivery

  **Gateway**: All event delivery now uses `EventMessage` format (`{ type: "event", event, sessionId, data }`) — SSE matches WebSocket. SSE clients are real transport clients via `EmbeddedSSETransport`, getting backpressure through `ClientEventBuffer`, appearing in `gateway.status.clients`, and receiving DevTools lifecycle events. Channel events reach all transports. WS clients can subscribe to and publish channel events via `channel-subscribe` and `channel` RPC methods. `GatewayEventType` derived from `StreamEvent["type"]`.

  **Client**: New `unwrapEventMessage()` utility normalizes `EventMessage` → flat format at every parse site (SSE, WS, client.ts). Handles both old and new formats for safe transition. Envelope fields always win over data properties to prevent collision.

### Patch Changes

- @agentick/kernel@0.8.0
- @agentick/shared@0.8.0
- @agentick/core@0.8.0
- @agentick/server@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [c73753e]
  - @agentick/core@0.7.0
  - @agentick/kernel@0.7.0
  - @agentick/shared@0.7.0
  - @agentick/server@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [e30960c]
- Updated dependencies [4750f5e]
  - @agentick/core@0.6.0
  - @agentick/shared@0.6.0
  - @agentick/kernel@0.6.0
  - @agentick/server@0.4.1

## 0.5.0

### Patch Changes

- Updated dependencies [156bc2f]
  - @agentick/core@0.5.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/kernel@0.4.0
  - @agentick/shared@0.4.0
  - @agentick/core@0.4.0
  - @agentick/server@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [d38460c]
  - @agentick/core@0.3.0

## 0.2.1

### Patch Changes

- 07b630c: Upgrade to React 19 and react-reconciler 0.33. useComState now uses useSyncExternalStore for correct external state synchronization. Clean up dead code from reconciler migration.
- Updated dependencies [07b630c]
  - @agentick/core@0.2.1
  - @agentick/kernel@0.2.1
  - @agentick/shared@0.2.1
  - @agentick/server@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/core@0.2.0
  - @agentick/kernel@0.2.0
  - @agentick/shared@0.2.0
  - @agentick/server@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/core@0.1.9
  - @agentick/kernel@0.1.9
  - @agentick/shared@0.1.9
  - @agentick/server@0.1.9
