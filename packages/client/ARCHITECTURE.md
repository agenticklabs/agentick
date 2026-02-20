# @agentick/client Architecture

The client is a multiplexed consumer that provides **cold/hot session accessors** and **execution handles**. It is intentionally thin and mirrors the server’s session model. The underlying transport is pluggable — SSE/HTTP, WebSocket, Unix socket, or in-process local.

## Key Concepts

### Client

- One client per app endpoint (e.g. `/api/analyst`)
- Manages transport connection lazily (opened on first subscribe)
- Dispatches multiplexed events to session accessors

### Session Accessor

- **Cold**: `client.session(id)` has no side effects
- **Hot**: `client.subscribe(id)` auto-subscribes
- `send()` returns a `ClientExecutionHandle`
- `onEvent()` receives all events for that session
- `channel(name)` is session-scoped pub/sub

### ClientExecutionHandle

- Async iterator for **this execution’s** events
- `.result` resolves to `SessionResultPayload`
- `.abort()` cancels execution

## Event Flow

```
client.send() / accessor.send()
  └─ POST /send
     └─ SSE stream (events tagged with sessionId)
          ├─ client.onEvent(...)
          └─ accessor.onEvent(...)
```

## Subscription Flow

```
client.subscribe('conv-123')
  └─ open SSE (if needed)
  └─ POST /subscribe { add: ['conv-123'] }
  └─ events flow → accessor.onEvent(...)
```

## Transports

The client works with any `ClientTransport` (from `@agentick/shared`). WebSocket and Unix socket transports are built on `createRPCTransport` — a shared factory that provides all protocol machinery (request correlation, event streaming, reconnection). Each transport delegate provides only wire-specific I/O (~120 lines each).

| Transport   | Factory                                   | Package             |
| ----------- | ----------------------------------------- | ------------------- |
| SSE/HTTP    | (default, built into client)              | `@agentick/client`  |
| WebSocket   | `createWSTransport(config)`               | `@agentick/client`  |
| Unix Socket | `createUnixSocketClientTransport(config)` | `@agentick/gateway` |
| Local       | `createLocalTransport(app)`               | `@agentick/core`    |

## Single Story

- No `createSession()` or `connect()` calls
- Sessions are server-managed actors
- Client is a thin multiplexing layer
