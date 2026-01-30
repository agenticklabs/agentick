# @tentickle/nestjs Architecture

NestJS integration wraps `App` with dependency injection and controller sugar.

## Core Idea

- Inject `App` via `TENTICKLE_APP` token
- `TentickleService` manages connections/subscriptions (mirrors Express router)
- `TentickleController` provides default REST endpoints
- No `SessionHandler` or `EventBridge` - those were legacy abstractions

## Flow

```
Module.forRoot({ app })
  └─ Providers: TENTICKLE_APP (app), TentickleService
  └─ Controller: TentickleController (optional)

TentickleService
  └─ Wraps App with connection/subscription management
  └─ Methods: sendAndStream, subscribe, abort, close, etc.
```

## No Legacy Paths

- No `createSession()` endpoint
- No `SessionHandler` or `EventBridge` injection
- Direct `App` access via `TENTICKLE_APP` token
