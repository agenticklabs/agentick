# Package Overview

Agentick is organized as a monorepo with layered packages. Each layer depends only on the layers below it.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Applications                               │
│        (your apps, CLI tools, servers)                              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                       Framework Layer                               │
│   @agentick/core      @agentick/gateway      @agentick/client       │
│   @agentick/express   @agentick/devtools     @agentick/agent        │
│   @agentick/tui       @agentick/react        @agentick/sandbox      │
│   @agentick/mcp       @agentick/connector    @agentick/secrets      │
│   @agentick/scheduler                                               │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                        Adapter Layer                                │
│   @agentick/openai    @agentick/google    @agentick/ai-sdk          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                      Foundation Layer                               │
│             @agentick/kernel          @agentick/shared              │
│             (Node.js only)            (Platform-independent)        │
└─────────────────────────────────────────────────────────────────────┘
```

## Foundation

### @agentick/kernel

Procedures, execution tracking, AsyncLocalStorage context, middleware. Node.js only. No framework opinions — pure execution primitives.

### @agentick/shared

Wire-safe types, content blocks, messages, streaming types, tool definitions, timeline types, errors. Platform-independent — usable in browser and Node.js.

## Framework

### @agentick/core

The heart of agentick. Reconciler, fiber tree, compiler, hooks, JSX runtime, component model, app factory, sessions, tool system, knobs.

### @agentick/agent

High-level `createAgent()` factory and `<Agent>` component for quick setup without JSX boilerplate.

### @agentick/gateway

Multi-session management. Routes messages to sessions, manages lifecycle, provides a method-based API for external access. Supports HTTP/SSE, WebSocket, and Unix socket transports. Unix socket enables daemon mode — gateway as a background process, clients connect locally.

Includes three plugins:

- **MCP Server** — serves tools and resources as a standard MCP server via Streamable HTTP. Supports resources-only mode, tool annotations, resource templates, and per-session tool filtering. Any MCP client (Claude Desktop, Cursor, Claude Code, etc.) can connect.
- **OpenAI-Compatible** — serves `POST /v1/chat/completions` and `GET /v1/models`. Any OpenAI SDK client can point at the gateway and get streaming completions.
- **Logging** — structured lifecycle event logging (connections, sessions, errors) using the kernel's Logger (pino).

### @agentick/client

Browser/Node.js client for connecting to a running gateway. Real-time message streaming, session management. Includes Chat Primitives — composable building blocks (`ChatSession`, `MessageLog`, `ToolConfirmations`, `MessageSteering`) for chat UIs. Also provides `LineEditor` — a framework-agnostic readline-quality line editor with cursor movement, kill/yank, history, and keybindings.

### @agentick/server

Transport server — SSE and WebSocket support for exposing sessions to clients.

### @agentick/express

Express.js middleware integration. Mount agentick endpoints on an Express server.

### @agentick/react

React hooks and components for building UIs that connect to agentick sessions. Includes `useChat` (all-in-one), `useMessages`, `useToolConfirmations`, `useMessageSteering`, `useLineEditor` — React wrappers around the client's Chat Primitives and `LineEditor`.

### @agentick/tui

Terminal UI for Agentick agents. Uses Ink (React for CLIs) with `@agentick/react` hooks — same hooks, same streaming, different renderer. Works locally or over HTTP/SSE.

### @agentick/devtools

Fiber tree inspector, timeline viewer, execution debugger. Connect to running agents for real-time inspection.

### @agentick/mcp

Standalone MCP server and client implementation. Sits in the Framework Layer alongside core and gateway but depends only on kernel + shared (foundation). Can be installed alone for a fully functional MCP server without the gateway or reconciler.

Targets MCP specification **2025-11-25** (latest).

**Server** (`@agentick/mcp/server`) — per-session SDK `Server` pool with shared registry, dynamic tool/resource/prompt/app registration, `handleHTTPRequest` for HTTP, `connect` for in-process/stdio, security pipeline (`ConnectionGuard → contextProvider → Authenticator → Authorizer → RateLimiter → InputSanitizer`), session lifecycle (TTL, idle cleanup, max sessions), dual-path events, `toolFilter` for per-session tool visibility, `toolTransform` for per-session tool customization, and `securitySchemes` for OAuth metadata.

The `MCPRequestContext` — flowing through every pipeline stage and into handlers — carries user identity, client info (name, version, capabilities from the initialize handshake), session metadata (transport type, session ID, age from the session registry), SDK passthrough fields (authInfo, requestId, \_meta, taskId, requestInfo), and arbitrary application metadata. The `contextProvider` has first say; the server enriches anything it didn't set.

**Server-to-client requests** — `MCPServer.request<T>(sessionId, method, params, opts?)` issues a JSON-RPC request to the connected client and awaits the response. The bottom-layer primitive every bidirectional MCP feature builds on (sampling, elicitation, roots). Supports Zod result schemas, `timeoutMs`, and `AbortSignal`. Throws typed `SessionNotFoundError` for unknown sessions.

**Display metadata (`title` + `icons`)** — per MCP spec 2025-11-25 `BaseMetadataSchema` + `IconsSchema`, all four entity types (tools, prompts, resources, resource templates) accept optional `title?: string` (human-readable display name; falls back to `name` when omitted) and `icons?: Icon[]` (array of `{ src, mimeType?, sizes?, theme? }` for client UI rendering with multi-size and light/dark theme variants). Both fields are stripped from the wire when undefined/empty.

**Argument completions** — both `MCPPromptDefinition` and `MCPResourceTemplateDefinition` accept a `complete?: Record<string, CompletionHandler>` map. Sugar builders (`completeFromList`, `completeFromEnum`, `completePrefixMatch`, `completeDependent`, `completeFromAsync`) auto-enforce the spec's 100-value cap, set `hasMore` on truncation, and surface sibling args via `ctx.resolvedArguments`. The `completions: {}` capability is conditionally advertised only when at least one handler exists.

**Roots (filesystem boundaries)** — `MCPServer.listRoots(sessionId)` fetches the client's declared `file://` roots with per-session caching, auto-invalidated by `notifications/roots/list_changed`. Sugar surface on `ctx.roots`: `list()`, `isWithin(path)`, `assertWithin(path)`, `rootContaining(path)`, `resolveRelative(rel, { name? })`, `subscribe(listener)`. Permissive defaults (assertions pass when no roots are declared); accepts both POSIX paths and `file://` URIs; rejects sibling-name false matches.

**Sampling (server-initiated LLM calls)** — `MCPServer.requestSampling(sessionId, params)` issues `sampling/createMessage` to the connected client, whose host model runs the inference. Sugar surface on `ctx.sample` (undefined when client lacks the capability): `text(prompt)`, `message(params)`, `structured(prompt, { schema })` with Zod-validated JSON + auto-retry, `image({ prompt, size? })`, `audio({ prompt, voice? })`, and `withTools({ prompt, tools, maxIterations? })` that runs the spec-defined tool-use loop with `tool_use` / `tool_result` content blocks, `toolUseId` matching, and the tool-results-only message constraint. Capability probes (`canUseTools()`, `canSampleAudio()`, `canIncludeContext()`) gate behavior on `sampling.tools` / `sampling.context` sub-capabilities; `includeContext` is auto-scrubbed when not advertised.

**Elicitation (pause to ask the user)** — `MCPServer.requestElicitation(sessionId, params)` (form) and `requestUrlElicitation(sessionId, params)` (URL mode, new in 2025-11-25) issue `elicitation/create`. Sugar surface on `ctx.elicit` (undefined when client lacks any sub-cap): `text/select/multiSelect/confirm/number/object/url` plus `tryX` variants returning discriminated `{ status: "accept"|"decline"|"cancel" }` outcomes, `canDoForm()/canDoUrl()` probes, and `requireUrls()` for the `URLElicitationRequiredError -32042` deferred-auth pattern. Throw-by-default for non-accept actions (`ElicitationDeclined`, `ElicitationCancelled`). Schema flatness validated upfront for `object()` per spec (no nested objects, arrays must enumerate options). Capability shape `elicitation: { form: {}, url: {} }` with legacy `elicitation: {}` treated as form-only. **Client-side**: `MCPClient.elicitationHandler` option dispatches form/URL requests to the host UI; `elicitationModes` selects which sub-caps to advertise.

**Client** (`@agentick/mcp/client`) — multi-server connection pool with caching, auto-invalidation on change notifications, URI routing, reconnection with exponential backoff, progress callbacks, sampling, roots, logging, completions, cancellation, and OAuth support. Includes `getServerInfo()`, `getInstructions()`, `supportsMcpApps()`, and `getMcpAppsCapability()` for server metadata introspection.

**Transport** (`@agentick/mcp/transport`) — exports `InMemoryTransport` (own implementation with deferred delivery via `queueMicrotask`, fixing a race condition in the SDK's synchronous version) and the SDK's `Transport` type.

**Protocol** (`@agentick/mcp`) — types (`MCPRequestContext`, `MCPHandlerContext`, `MCPCompletionContext`, `MCPServerOptions`, `MCPToolDefinition`, `CompletionHandler`, security function signatures), error utilities (`toMCPResult`, `safeToolHandler`, `sanitizeErrorMessage`, `protocolError` for clean single-prefix JSON-RPC errors), JSON-RPC error codes, and JSON Schema 2020-12 dialect support via `kernel/schema.ts` (`upgradeToJsonSchema2020`).

### @agentick/sandbox

Sandbox primitive layer. Types, `<Sandbox>` component, pre-built tools (Shell, ReadFile, WriteFile, EditFile), and edit utilities. Provider adapters build on this.

### @agentick/secrets

Platform-native secret storage. Stores credentials in the OS keychain (macOS Keychain, Linux libsecret) with environment variable fallback. Auto-detects the best backend. No native dependencies — shells out to `security` / `secret-tool`.

### @agentick/scheduler

Scheduled jobs, heartbeat, and cron triggers. File-based persistence with crash recovery. JobStore persists jobs as JSON files, Scheduler manages node-cron timers, TriggerWatcher dispatches to sessions. External triggers via filesystem — system cron, scripts, manual writes.

### @agentick/guardrails

Guard system — `createGuard()`, `GuardError`, input/output validation for safety.

## Connectors

### @agentick/connector

Bridge external platforms to Agentick sessions. Content filtering, delivery timing, rate limiting, retry with backoff, and tool confirmations — so platform adapters only handle I/O.

### @agentick/connector-imessage

iMessage platform adapter. macOS only. Polls `chat.db` for incoming messages and sends responses via AppleScript through Messages.app.

### @agentick/connector-telegram

Telegram platform adapter. Bridge a Telegram bot to an agent session via [grammY](https://grammy.dev).

## Adapters

### @agentick/openai

OpenAI adapter. GPT-4o, GPT-4, GPT-3.5, o-series models.

### @agentick/google

Google Gemini adapter. Gemini Pro, Gemini Flash.

### @agentick/ai-sdk

Vercel AI SDK adapter. Any model supported by the AI SDK.

## Convenience

### agentick

Re-exports everything from `@agentick/core`, `@agentick/agent`, and `@agentick/guardrails`. One install, one import source:

```bash
npm install agentick
```
