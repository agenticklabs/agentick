# @tentickle/angular

Angular service for Tentickle clients.

## Installation

```bash
npm install @tentickle/angular @tentickle/client
# or
pnpm add @tentickle/angular @tentickle/client
```

## Quick Start

### Standalone Setup

```typescript
import { bootstrapApplication } from "@angular/platform-browser";
import { TentickleService, TENTICKLE_CONFIG } from "@tentickle/angular";

bootstrapApplication(AppComponent, {
  providers: [
    TentickleService,
    { provide: TENTICKLE_CONFIG, useValue: { baseUrl: "https://api.example.com" } },
  ],
});
```

### NgModule Setup

```typescript
import { TentickleService, TENTICKLE_CONFIG } from "@tentickle/angular";

@NgModule({
  providers: [
    TentickleService,
    { provide: TENTICKLE_CONFIG, useValue: { baseUrl: "https://api.example.com" } },
  ],
})
export class AppModule {}
```

### Component Usage

```typescript
import { Component, inject } from "@angular/core";
import { AsyncPipe } from "@angular/common";
import { TentickleService } from "@tentickle/angular";

@Component({
  selector: "app-chat",
  standalone: true,
  imports: [AsyncPipe],
  template: `
    @if (session$ | async; as session) {
      @if (session.isConnecting) {
        <p>Connecting...</p>
      }
      @if (session.isConnected) {
        <div class="response">
          {{ text$ | async }}
          @if (isStreaming$ | async) {
            <span class="cursor">|</span>
          }
        </div>
        <input #input />
        <button (click)="send(input.value); input.value = ''">Send</button>
      }
    }
  `,
})
export class ChatComponent {
  private tentickle = inject(TentickleService);

  session$ = this.tentickle.session$;
  text$ = this.tentickle.text$;
  isStreaming$ = this.tentickle.isStreaming$;

  constructor() {
    this.tentickle.connect();
  }

  async send(message: string) {
    await this.tentickle.send(message);
    await this.tentickle.tick();
  }
}
```

## API

### Observables

| Observable | Type | Description |
|------------|------|-------------|
| `session$` | `SessionState` | Full session state |
| `connectionState$` | `ConnectionState` | Connection state only |
| `isConnected$` | `boolean` | Whether connected |
| `events$` | `StreamEvent` | All stream events |
| `streamingText$` | `StreamingTextState` | Text + isStreaming |
| `text$` | `string` | Accumulated text |
| `isStreaming$` | `boolean` | Whether streaming |
| `result$` | `Result` | Execution results |

### Methods

| Method | Description |
|--------|-------------|
| `connect(sessionId?, props?)` | Connect to session |
| `disconnect()` | Disconnect |
| `send(content)` | Send message |
| `tick(props?)` | Trigger tick |
| `abort(reason?)` | Abort execution |
| `channel(name)` | Get channel accessor |
| `channel$(name)` | Get channel as Observable |
| `eventsOfType(...types)` | Filter events by type |
| `clearStreamingText()` | Clear accumulated text |

### Synchronous Getters

```typescript
service.isConnected   // boolean
service.sessionId     // string | undefined
service.session       // SessionState
```

## Configuration

```typescript
interface TentickleConfig {
  baseUrl: string;
  token?: string;
  userId?: string;
  headers?: Record<string, string>;
  paths?: { events?: string; sessions?: string };
  timeout?: number;
}
```

### Factory Provider

```typescript
{
  provide: TENTICKLE_CONFIG,
  useFactory: (auth: AuthService) => ({
    baseUrl: environment.apiUrl,
    token: auth.getToken(),
  }),
  deps: [AuthService],
}
```

## TypeScript

```typescript
import type {
  TentickleConfig,
  SessionState,
  StreamingTextState,
  ConnectionState,
  StreamEvent,
} from "@tentickle/angular";
```

## License

MIT
