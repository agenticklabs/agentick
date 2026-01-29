# @tentickle/nestjs Architecture

NestJS module for Tentickle servers. Wraps `@tentickle/server` with NestJS patterns: modules, dependency injection, and decorators.

## Design Philosophy

**NestJS-native integration**: Uses NestJS patterns - dynamic modules, injection tokens, controller decorators, and async configuration factories.

**Framework agnostic handlers**: The actual session/event logic lives in `@tentickle/server`. This package just wires it into NestJS DI.

**No assumptions**: The module provides I/O primitives. Authentication, authorization, and business logic belong to your application.

## Package Structure

```
src/
├── index.ts              # Public exports
├── tentickle.module.ts   # NestJS module
├── tentickle.controller.ts # Default REST controller
└── types.ts              # Types and injection tokens
```

## Core Components

### TentickleModule

Dynamic module that creates and provides:

- `TENTICKLE_SESSION_HANDLER` - SessionHandler instance
- `TENTICKLE_EVENT_BRIDGE` - EventBridge instance

```typescript
@Module({
  imports: [
    TentickleModule.forRoot({
      sessionHandler: { app: myApp },
    }),
  ],
})
export class AppModule {}
```

### TentickleController

Default controller providing REST + SSE endpoints:

- `POST /sessions` - Create session
- `GET /sessions/:id` - Get session state
- `POST /sessions/:id/messages` - Send message
- `POST /sessions/:id/tick` - Trigger tick
- `POST /sessions/:id/abort` - Abort execution
- `GET /events` - SSE stream
- `POST /events` - Publish event

Can be disabled via `registerController: false` for custom implementations.

### Injection Tokens

```typescript
export const TENTICKLE_OPTIONS = "TENTICKLE_OPTIONS";
export const TENTICKLE_SESSION_HANDLER = "TENTICKLE_SESSION_HANDLER";
export const TENTICKLE_EVENT_BRIDGE = "TENTICKLE_EVENT_BRIDGE";
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    NestJS Application                        │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              TentickleController                     │   │
│   │  (or your custom controller)                         │   │
│   │                                                      │   │
│   │  POST /sessions      →  sessionHandler.create()     │   │
│   │  POST /sessions/:id  →  sessionHandler.send()       │   │
│   │  GET /events         →  eventBridge.register()      │   │
│   │  POST /events        →  eventBridge.handleEvent()   │   │
│   └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              TentickleModule                         │   │
│   │                                                      │   │
│   │  TENTICKLE_SESSION_HANDLER → SessionHandler         │   │
│   │  TENTICKLE_EVENT_BRIDGE    → EventBridge            │   │
│   └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              @tentickle/server                       │   │
│   │                                                      │   │
│   │  createSessionHandler()                             │   │
│   │  createEventBridge()                                │   │
│   └─────────────────────────────────────────────────────┘   │
│                           │                                  │
└───────────────────────────┼─────────────────────────────────┘
                            │
                            ▼
                      Tentickle App
```

## Configuration Patterns

### Static Configuration

```typescript
TentickleModule.forRoot({
  sessionHandler: {
    app: createApp(<MyAgent />),
    store: new RedisSessionStore(),
  },
  eventBridge: {
    validateEvent: (conn, event) => {
      if (event.channel.startsWith("admin:")) {
        throw new Error("Forbidden");
      }
    },
  },
})
```

### Async Configuration

```typescript
TentickleModule.forRootAsync({
  imports: [ConfigModule, AppModule],
  useFactory: (config: ConfigService, appService: AppService) => ({
    sessionHandler: {
      app: appService.createAgentApp(),
    },
    path: config.get("TENTICKLE_PATH"),
  }),
  inject: [ConfigService, AppService],
})
```

### Factory Class

```typescript
@Injectable()
class TentickleConfigService implements TentickleModuleOptionsFactory {
  constructor(private config: ConfigService) {}

  createTentickleOptions(): TentickleModuleOptions {
    return {
      sessionHandler: { app: createApp(<MyAgent />) },
    };
  }
}

TentickleModule.forRootAsync({
  useClass: TentickleConfigService,
})
```

## Custom Controllers

```typescript
@Module({
  imports: [
    TentickleModule.forRoot({
      sessionHandler: { app },
      registerController: false, // Disable default
    }),
  ],
  controllers: [ChatController],
})
export class ChatModule {}

@Controller("chat")
export class ChatController {
  constructor(
    @Inject(TENTICKLE_SESSION_HANDLER)
    private sessionHandler: SessionHandler,
  ) {}

  @Post("conversations")
  async create(@Body() dto: CreateConversationDto, @User() user: UserEntity) {
    const { sessionId } = await this.sessionHandler.create({
      props: {
        userId: user.id,
        organizationId: user.organizationId,
      },
    });
    return { conversationId: sessionId };
  }
}
```

## Type Exports

```typescript
// Module and controller
export { TentickleModule } from "./tentickle.module.js";
export { TentickleController } from "./tentickle.controller.js";

// Injection tokens
export {
  TENTICKLE_OPTIONS,
  TENTICKLE_SESSION_HANDLER,
  TENTICKLE_EVENT_BRIDGE,
} from "./types.js";

// Types
export type {
  TentickleModuleOptions,
  TentickleModuleAsyncOptions,
  TentickleModuleOptionsFactory,
  SessionHandler,
  EventBridge,
  CreateSessionInput,
  SendInput,
  ServerConnection,
  SessionStateInfo,
} from "./types.js";
```
