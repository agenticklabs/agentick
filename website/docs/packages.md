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
│   @agentick/connector  @agentick/secrets    @agentick/scheduler       │
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

Multi-session management. Routes messages to sessions, manages lifecycle, provides a method-based API for external access.

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
