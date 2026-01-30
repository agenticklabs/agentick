# @tentickle/angular Architecture

The Angular package is a thin wrapper around `@tentickle/client` using signals.

## Core Idea

- One service instance per app or component
- Session access via `subscribe(sessionId)` or `session(sessionId)`
- Streaming text and connection state exposed as signals

## Session Flow

```
subscribe(sessionId)
  └─ client.subscribe(sessionId)
  └─ events → service.events$ / signals

send(input)
  └─ session.send(...) or client.send(...)
  └─ returns ClientExecutionHandle
```

## No Legacy Paths

- No `createSession()`
- No `connect()` / `disconnect()`
- No `tick()`
