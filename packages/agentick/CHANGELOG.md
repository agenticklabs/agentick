# agentick

## 0.14.33

### Patch Changes

- @agentick/core@0.14.33
- @agentick/agent@0.14.33
- @agentick/guardrails@0.14.33

## 0.14.32

### Patch Changes

- @agentick/core@0.14.32
- @agentick/agent@0.14.32
- @agentick/guardrails@0.14.32

## 0.14.31

### Patch Changes

- @agentick/core@0.14.31
- @agentick/agent@0.14.31
- @agentick/guardrails@0.14.31

## 0.14.30

### Patch Changes

- Updated dependencies [29ddb7a]
  - @agentick/core@0.14.30
  - @agentick/agent@0.14.30
  - @agentick/guardrails@0.14.30

## 0.14.29

### Patch Changes

- Updated dependencies [d8b1984]
  - @agentick/core@0.14.29
  - @agentick/agent@0.14.29
  - @agentick/guardrails@0.14.29

## 0.14.28

### Patch Changes

- @agentick/core@0.14.28
- @agentick/agent@0.14.28
- @agentick/guardrails@0.14.28

## 0.14.27

### Patch Changes

- @agentick/core@0.14.27
- @agentick/agent@0.14.27
- @agentick/guardrails@0.14.27

## 0.14.26

### Patch Changes

- @agentick/core@0.14.26
- @agentick/agent@0.14.26
- @agentick/guardrails@0.14.26

## 0.14.25

### Patch Changes

- b602b9b: feat(mcp): unified `<MCP>` component with progressive resource discovery

  New `<MCP>` component connects to MCP servers and provides both tools and resources. Tools are registered per-server. Resources are unified under `list_resources` and `read_resource` tools across all servers.

  - `MCPClient`: resource discovery (`listResources`, `readResource`, `listResourceTemplates`), URI routing (`readResourceByURI`), cache invalidation
  - `MCPResourceComponent`: terrain map in context + progressive resource tools
  - `MCPComponent` (`<MCP>`): single component for tools + resources with shared client
  - Exported from `"agentick"`: `MCP`, `MCPClient`, `MCPConfig`, `MCPResource`, etc.

- Updated dependencies [b602b9b]
  - @agentick/core@0.14.25
  - @agentick/agent@0.14.25
  - @agentick/guardrails@0.14.25

## 0.14.24

### Patch Changes

- @agentick/core@0.14.24
- @agentick/agent@0.14.24
- @agentick/guardrails@0.14.24

## 0.14.23

### Patch Changes

- @agentick/core@0.14.23
- @agentick/agent@0.14.23
- @agentick/guardrails@0.14.23

## 0.14.22

### Patch Changes

- @agentick/core@0.14.22
- @agentick/agent@0.14.22
- @agentick/guardrails@0.14.22

## 0.14.21

### Patch Changes

- @agentick/core@0.14.21
- @agentick/agent@0.14.21
- @agentick/guardrails@0.14.21

## 0.14.20

### Patch Changes

- @agentick/core@0.14.20
- @agentick/agent@0.14.20
- @agentick/guardrails@0.14.20

## 0.14.19

### Patch Changes

- @agentick/core@0.14.19
- @agentick/agent@0.14.19
- @agentick/guardrails@0.14.19

## 0.14.18

### Patch Changes

- @agentick/core@0.14.18
- @agentick/agent@0.14.18
- @agentick/guardrails@0.14.18

## 0.14.17

### Patch Changes

- @agentick/core@0.14.17
- @agentick/agent@0.14.17
- @agentick/guardrails@0.14.17

## 0.14.16

### Patch Changes

- Updated dependencies [59a9281]
  - @agentick/core@0.14.16
  - @agentick/agent@0.14.16
  - @agentick/guardrails@0.14.16

## 0.14.15

### Patch Changes

- @agentick/core@0.14.15
- @agentick/agent@0.14.15
- @agentick/guardrails@0.14.15

## 0.14.14

### Patch Changes

- @agentick/core@0.14.14
- @agentick/agent@0.14.14
- @agentick/guardrails@0.14.14

## 0.14.13

### Patch Changes

- @agentick/core@0.14.13
- @agentick/agent@0.14.13
- @agentick/guardrails@0.14.13

## 0.14.12

### Patch Changes

- Updated dependencies [04451f0]
  - @agentick/core@0.14.12
  - @agentick/agent@0.14.12
  - @agentick/guardrails@0.14.12

## 0.14.11

### Patch Changes

- @agentick/core@0.14.11
- @agentick/agent@0.14.11
- @agentick/guardrails@0.14.11

## 0.14.10

### Patch Changes

- @agentick/core@0.14.10
- @agentick/agent@0.14.10
- @agentick/guardrails@0.14.10

## 0.14.9

### Patch Changes

- @agentick/core@0.14.9
- @agentick/agent@0.14.9
- @agentick/guardrails@0.14.9

## 0.14.8

### Patch Changes

- @agentick/core@0.14.8
- @agentick/agent@0.14.8
- @agentick/guardrails@0.14.8

## 0.14.7

### Patch Changes

- @agentick/core@0.14.7
- @agentick/agent@0.14.7
- @agentick/guardrails@0.14.7

## 0.14.6

### Patch Changes

- 6b72302: fix: add "default" export condition to publishConfig exports

  Node's CJS resolver needs "default" or "require" in the exports map. Without it, require() throws ERR_PACKAGE_PATH_NOT_EXPORTED. Fixes intermittent crashes when nx's node executor loads packages via require().

- Updated dependencies [6b72302]
  - @agentick/core@0.14.6
  - @agentick/guardrails@0.14.6
  - @agentick/agent@0.14.6

## 0.14.5

### Patch Changes

- @agentick/agent@0.14.5
- @agentick/core@0.14.5
- @agentick/guardrails@0.14.5

## 0.14.4

### Patch Changes

- Updated dependencies [cc1ee21]
  - @agentick/core@0.14.4
  - @agentick/agent@0.14.4
  - @agentick/guardrails@0.14.4

## 0.14.3

### Patch Changes

- @agentick/core@0.14.3
- @agentick/agent@0.14.3
- @agentick/guardrails@0.14.3

## 0.14.2

### Patch Changes

- @agentick/core@0.14.2
- @agentick/agent@0.14.2
- @agentick/guardrails@0.14.2

## 0.14.1

### Patch Changes

- @agentick/core@0.14.1
- @agentick/agent@0.14.1
- @agentick/guardrails@0.14.1

## 0.14.0

### Patch Changes

- @agentick/core@0.14.0
- @agentick/agent@0.14.0
- @agentick/guardrails@0.14.0

## 0.13.2

### Patch Changes

- @agentick/core@0.13.2
- @agentick/agent@0.13.2
- @agentick/guardrails@0.13.2

## 0.13.1

### Patch Changes

- @agentick/core@0.13.1
- @agentick/agent@0.13.1
- @agentick/guardrails@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [8e568d1]
  - @agentick/core@0.13.0
  - @agentick/agent@0.13.0
  - @agentick/guardrails@0.13.0

## 0.12.3

### Patch Changes

- @agentick/core@0.12.3
- @agentick/guardrails@0.12.3
- @agentick/agent@0.12.3

## 0.12.2

### Patch Changes

- @agentick/core@0.12.2
- @agentick/agent@0.12.2
- @agentick/guardrails@0.12.2

## 0.12.1

### Patch Changes

- @agentick/core@0.12.1
- @agentick/agent@0.12.1
- @agentick/guardrails@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [2435355]
  - @agentick/core@0.12.0
  - @agentick/agent@0.12.0
  - @agentick/guardrails@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies [6d169a8]
  - @agentick/core@0.11.2
  - @agentick/agent@0.11.2
  - @agentick/guardrails@0.11.2

## 0.11.1

### Patch Changes

- @agentick/agent@0.11.1
- @agentick/core@0.11.1
- @agentick/guardrails@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [10023a7]
  - @agentick/core@0.11.0
  - @agentick/agent@0.11.0
  - @agentick/guardrails@0.11.0

## 0.10.1

### Patch Changes

- @agentick/agent@0.10.1
- @agentick/core@0.10.1
- @agentick/guardrails@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [619c448]
  - @agentick/core@0.10.0
  - @agentick/agent@0.10.0
  - @agentick/guardrails@0.10.0

## 0.9.6

### Patch Changes

- 84752df: Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.
- Updated dependencies [84752df]
  - @agentick/core@0.9.6
  - @agentick/agent@0.9.6
  - @agentick/guardrails@0.9.6

## 0.9.5

### Patch Changes

- Updated dependencies [dc26053]
  - @agentick/core@0.9.5
  - @agentick/agent@0.9.5
  - @agentick/guardrails@0.9.5

## 0.9.4

### Patch Changes

- @agentick/core@0.9.4
- @agentick/agent@0.9.4
- @agentick/guardrails@0.9.4

## 0.9.3

### Patch Changes

- Updated dependencies [1a4c9b0]
  - @agentick/core@0.9.3
  - @agentick/agent@0.9.3
  - @agentick/guardrails@0.9.3

## 0.9.2

### Patch Changes

- @agentick/core@0.9.2
- @agentick/guardrails@0.9.2
- @agentick/agent@0.9.2

## 0.9.1

### Patch Changes

- @agentick/agent@0.9.1
- @agentick/core@0.9.1
- @agentick/guardrails@0.9.1

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
  - @agentick/core@0.9.0
  - @agentick/agent@0.9.0
  - @agentick/guardrails@0.9.0

## 0.8.0

### Patch Changes

- @agentick/core@0.8.0
- @agentick/agent@0.8.0
- @agentick/guardrails@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [c73753e]
  - @agentick/core@0.7.0
  - @agentick/agent@0.7.0
  - @agentick/guardrails@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [e30960c]
- Updated dependencies [4750f5e]
  - @agentick/core@0.6.0
  - @agentick/agent@0.5.1
  - @agentick/guardrails@0.4.1

## 0.5.0

### Patch Changes

- Updated dependencies [156bc2f]
  - @agentick/core@0.5.0
  - @agentick/agent@0.5.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/core@0.4.0
  - @agentick/agent@0.4.0
  - @agentick/guardrails@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [d38460c]
  - @agentick/core@0.3.0
  - @agentick/agent@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [07b630c]
  - @agentick/core@0.2.1
  - @agentick/agent@0.2.1
  - @agentick/guardrails@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/core@0.2.0
  - @agentick/agent@0.2.0
  - @agentick/guardrails@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/core@0.1.9
