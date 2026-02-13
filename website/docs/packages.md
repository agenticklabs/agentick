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
│   @agentick/tui       @agentick/react        @agentick/sandbox        │
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

Browser/Node.js client for connecting to a running gateway. Real-time message streaming, session management. Includes [Chat Primitives](/packages/client/README.md#chat-primitives) — composable building blocks (`ChatSession`, `MessageLog`, `ToolConfirmations`, `MessageSteering`) for chat UIs.

### @agentick/server

Transport server — SSE and WebSocket support for exposing sessions to clients.

### @agentick/express

Express.js middleware integration. Mount agentick endpoints on an Express server.

### @agentick/react

React hooks and components for building UIs that connect to agentick sessions. Includes `useChat` (all-in-one), `useMessages`, `useToolConfirmations`, `useMessageSteering` — React wrappers around the client's [Chat Primitives](/packages/client/README.md#chat-primitives).

### @agentick/tui

Terminal UI for Agentick agents. Uses Ink (React for CLIs) with `@agentick/react` hooks — same hooks, same streaming, different renderer. Works locally or over HTTP/SSE.

### @agentick/devtools

Fiber tree inspector, timeline viewer, execution debugger. Connect to running agents for real-time inspection.

### @agentick/sandbox

Sandbox primitive layer. Types, `<Sandbox>` component, pre-built tools (Shell, ReadFile, WriteFile, EditFile), and edit utilities. Provider adapters build on this.

### @agentick/guardrails

Guard system — `createGuard()`, `GuardError`, input/output validation for safety.

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
