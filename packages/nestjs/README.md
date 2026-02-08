# @agentick/nestjs

NestJS integration for Agentick with multiplexed SSE sessions.

## Installation

```bash
pnpm add @agentick/nestjs
```

## Quick Start

```typescript
import { Module } from "@nestjs/common";
import { AgentickModule } from "@agentick/nestjs";
import { createApp } from "@agentick/core";

@Module({
  imports: [
    AgentickModule.forRoot({
      app: createApp(<MyAgent />),
    }),
  ],
})
export class AppModule {}
```

## Default Endpoints

| Method | Path             | Description              |
| ------ | ---------------- | ------------------------ |
| GET    | `/events`        | SSE stream               |
| POST   | `/send`          | Send and stream          |
| POST   | `/subscribe`     | Subscribe to sessions    |
| POST   | `/abort`         | Abort execution          |
| POST   | `/close`         | Close session            |
| POST   | `/tool-response` | Submit tool confirmation |
| POST   | `/channel`       | Publish to channel       |

## Custom Controller

```typescript
@Module({
  imports: [
    AgentickModule.forRoot({
      app,
      registerController: false,
    }),
  ],
  controllers: [ChatController],
})
export class AppModule {}

@Controller("chat")
export class ChatController {
  constructor(private agentick: AgentickService) {}

  @Post("send")
  async send(@Body() body: SendDto, @Res() res: Response) {
    await this.agentick.sendAndStream(body.sessionId, body, res);
  }
}
```

## AgentickService

```typescript
service.createConnection(res)             // SSE connection
service.subscribe(connId, sessionIds)     // Subscribe
service.unsubscribe(connId, sessionIds)   // Unsubscribe
service.sendAndStream(sessionId, input, res)  // Send and stream
service.abort(sessionId, reason?)         // Abort
service.close(sessionId)                  // Close
service.publishToChannel(sessionId, channel, type, payload)  // Channel pub
service.getApp()                          // Direct App access
```

## Inject App Directly

```typescript
@Injectable()
export class MyService {
  constructor(@Inject(TENTICKLE_APP) private app: App) {
    const session = this.app.session("conv-123");
  }
}
```
