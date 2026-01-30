# @tentickle/client Architecture

The client is a multiplexed SSE consumer that provides **cold/hot session accessors** and **execution handles**. It is intentionally thin and mirrors the server’s session model.

## Key Concepts

### Client

- One client per app endpoint (e.g. `/api/analyst`)
- Manages a single SSE connection lazily (opened on first subscribe)
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

## Single Story

- No `createSession()` or `connect()` calls
- No legacy transport abstraction
- Sessions are server-managed actors
- Client is a thin multiplexing layer
