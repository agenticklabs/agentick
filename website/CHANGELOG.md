# agentick-website

## 1.0.4

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

## 1.0.3

### Patch Changes

- 169967a: docs

## 1.0.2

### Patch Changes

- 152943e: fix package exports for default imports

## 1.1.0

### @agentick/mcp

- **Custom InMemoryTransport** — replaces SDK re-export with own implementation using `queueMicrotask` for deferred delivery. Fixes "unknown message ID" race condition when server connects before client registers response handlers. (`packages/mcp/src/transport/in-memory.ts`)
- **Server capability negotiation** — `MCPServer` advertises `extensions["io.modelcontextprotocol/ui"]` when apps are registered. New `description` field on `MCPServerOptions` passed to SDK Server's `serverInfo`. Constants: `MCP_APP_MIME_TYPE`, `MCP_APPS_EXTENSION_ID`.
- **MCPClient metadata methods** — `getServerInfo(serverName)` returns `{ name, version, description }` from the initialize handshake. `getInstructions(serverName)` returns the server's instructions string. Client advertises `io.modelcontextprotocol/ui` capability by default (opt out via `mcpApps: false`).
- **MCPTransport type** — added `"in-process"` to the union type and `MCPToolConfig.transport`.

### @agentick/gateway

- **MCP plugin config** — `name`, `version`, and `description` fields added (deprecates `serverName`/`serverVersion`). `MCPStandaloneTool` interface now includes `ui` and `_meta` fields for MCP Apps linkage passthrough to `MCPServer`.

### @agentick/core

- **Tool schema normalization** — `normalizeModelInput` and `resolveTools` are now async. `enrichMetadata` converts Zod schemas to JSON Schema via kernel's `toJSONSchema`; plain JSON Schema objects detected via `detectSchemaType` and passed through. All adapters receive `metadata.inputSchema` (JSON Schema) alongside `metadata.input` (Zod).
- **Compiler collector fix** — `collectTool` reads `node.props.input ?? node.props.schema` (was only `schema`). Fixes `<Tool input={z.object(...)}>` where the schema was silently dropped.
- **MCPServerInfoSection** — new `<MCPServerInfoSection>` component renders connected MCP server metadata (name/version/description, instructions, tools/resources summary) into the model's context. Automatically included by the `<MCP>` component. Uses `useData` for async metadata fetch.

### @agentick/google

- **mapToolDefinition** — reads `metadata.inputSchema ?? metadata.input` for JSON Schema fallback. `ensureObjectSchema` wraps empty `{}` parameters with `{ type: "object" }` for Gemini compliance. `prepareInput` is now async.

### @agentick/openai, @agentick/apple

- `prepareInput` is now async (signature change to support async `normalizeModelInput`).

## 1.0.1

### Patch Changes

- 152ac52: add logging middleware
