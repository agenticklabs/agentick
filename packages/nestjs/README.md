# @tentickle/nestjs

NestJS module for Tentickle servers.

## Installation

```bash
npm install @tentickle/nestjs @tentickle/server @tentickle/core
# or
pnpm add @tentickle/nestjs @tentickle/server @tentickle/core
```

## Quick Start

```typescript
import { Module } from "@nestjs/common";
import { TentickleModule } from "@tentickle/nestjs";
import { createApp } from "@tentickle/core";
import { MyAgent } from "./my-agent";

@Module({
  imports: [
    TentickleModule.forRoot({
      sessionHandler: {
        app: createApp(<MyAgent />),
      },
    }),
  ],
})
export class AppModule {}
```

## API

### TentickleModule.forRoot(options)

Register module with static configuration.

```typescript
TentickleModule.forRoot({
  sessionHandler: {
    app: createApp(<MyAgent />),
    store: new CustomSessionStore(), // Optional
  },
  eventBridge: {
    validateEvent: (conn, event) => { /* optional validation */ },
  },
  path: "api/ai",           // Optional: customize route prefix
  registerController: true,  // Optional: set false for custom routes
})
```

### TentickleModule.forRootAsync(options)

Register module with async configuration.

```typescript
TentickleModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService) => ({
    sessionHandler: {
      app: createApp(<MyAgent />),
    },
    path: config.get("TENTICKLE_PATH"),
  }),
  inject: [ConfigService],
})
```

### Default Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions` | Create session |
| GET | `/sessions/:id` | Get session state |
| POST | `/sessions/:id/messages` | Send message |
| POST | `/sessions/:id/tick` | Trigger tick |
| POST | `/sessions/:id/abort` | Abort execution |
| GET | `/events?sessionId=xxx` | SSE stream |
| POST | `/events` | Publish event |

### Injection Tokens

```typescript
import { Inject } from "@nestjs/common";
import {
  TENTICKLE_SESSION_HANDLER,
  TENTICKLE_EVENT_BRIDGE,
  SessionHandler,
  EventBridge,
} from "@tentickle/nestjs";

@Injectable()
export class ChatService {
  constructor(
    @Inject(TENTICKLE_SESSION_HANDLER)
    private sessionHandler: SessionHandler,
    @Inject(TENTICKLE_EVENT_BRIDGE)
    private eventBridge: EventBridge,
  ) {}
}
```

## Custom Routes

Disable the default controller to define your own:

```typescript
@Module({
  imports: [
    TentickleModule.forRoot({
      sessionHandler: { app },
      registerController: false,
    }),
  ],
  controllers: [MyCustomController],
})
export class AppModule {}

@Controller("chat")
export class MyCustomController {
  constructor(
    @Inject(TENTICKLE_SESSION_HANDLER)
    private sessionHandler: SessionHandler,
  ) {}

  @Post()
  async startChat(@Body() body: StartChatDto) {
    const { sessionId } = await this.sessionHandler.create({
      props: { userId: body.userId },
    });
    return { sessionId };
  }
}
```

## Configuration Options

```typescript
interface TentickleModuleOptions {
  sessionHandler: {
    app: App;
    store?: SessionStore;
    defaultSessionOptions?: Record<string, unknown>;
  };
  eventBridge?: {
    transport?: ServerTransportAdapter;
    validateEvent?: (connection, event) => void | Promise<void>;
  };
  path?: string;              // Route prefix (default: none)
  registerController?: boolean; // Register default controller (default: true)
}
```

## TypeScript

```typescript
import type {
  TentickleModuleOptions,
  TentickleModuleAsyncOptions,
  SessionHandler,
  EventBridge,
  CreateSessionInput,
  SendInput,
} from "@tentickle/nestjs";
```

## License

MIT
