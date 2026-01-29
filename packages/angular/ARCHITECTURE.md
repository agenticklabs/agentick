# @tentickle/angular Architecture

Angular service for Tentickle that wraps `@tentickle/client` with RxJS observables and Angular dependency injection.

## Design Philosophy

**Angular-native integration**: Uses Angular's patterns - injectable services, InjectionToken for configuration, RxJS observables for reactive state, and proper lifecycle management with `OnDestroy`.

**Observable-first API**: All state is exposed as RxJS observables for seamless integration with Angular's async pipe and reactive patterns.

**No assumptions**: The service provides I/O primitives. Authentication, routing, business logic belong to your application.

## Package Structure

```
src/
├── index.ts              # Public exports with documentation
├── tentickle.service.ts  # Main Angular service
└── types.ts              # TypeScript types
```

## Core Components

### TentickleService

Injectable service that wraps `TentickleClient`:

```typescript
@Injectable()
export class TentickleService implements OnDestroy {
  // Observables
  session$: Observable<SessionState>
  connectionState$: Observable<ConnectionState>
  isConnected$: Observable<boolean>
  events$: Observable<StreamEvent>
  streamingText$: Observable<StreamingTextState>
  text$: Observable<string>
  isStreaming$: Observable<boolean>
  result$: Observable<Result>

  // Methods
  connect(sessionId?, props?): Promise<void>
  disconnect(): Promise<void>
  send(content): Promise<void>
  tick(props?): Promise<void>
  abort(reason?): Promise<void>
  channel(name): ChannelAccessor
  channel$(name): Observable<ChannelEvent>
  eventsOfType(...types): Observable<StreamEvent>
  clearStreamingText(): void
}
```

### TENTICKLE_CONFIG

InjectionToken for providing configuration:

```typescript
export const TENTICKLE_CONFIG = new InjectionToken<TentickleConfig>('TENTICKLE_CONFIG');
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Angular Component                         │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  {{ session$ | async }}                             │   │
│   │  {{ text$ | async }}                                │   │
│   │  {{ isStreaming$ | async }}                         │   │
│   └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              TentickleService                        │   │
│   │                                                      │   │
│   │  BehaviorSubject<SessionState> ─► session$          │   │
│   │  BehaviorSubject<StreamingText>─► streamingText$    │   │
│   │  Subject<StreamEvent>          ─► events$           │   │
│   │  Subject<Result>               ─► result$           │   │
│   │                                                      │   │
│   │  connect() / disconnect() / send() / tick()         │   │
│   └─────────────────────────────────────────────────────┘   │
│                           │                                  │
│                           ▼                                  │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              TentickleClient                         │   │
│   │              (@tentickle/client)                     │   │
│   └─────────────────────────────────────────────────────┘   │
│                           │                                  │
└───────────────────────────┼─────────────────────────────────┘
                            │
                            ▼
                    Tentickle Server
```

## Setup Patterns

### NgModule Setup

```typescript
import { TentickleService, TENTICKLE_CONFIG } from '@tentickle/angular';

@NgModule({
  providers: [
    TentickleService,
    {
      provide: TENTICKLE_CONFIG,
      useValue: {
        baseUrl: 'https://api.example.com',
        token: 'my-auth-token',
      },
    },
  ],
})
export class AppModule {}
```

### Standalone Setup

```typescript
import { TentickleService, TENTICKLE_CONFIG } from '@tentickle/angular';

bootstrapApplication(AppComponent, {
  providers: [
    TentickleService,
    { provide: TENTICKLE_CONFIG, useValue: { baseUrl: 'https://api.example.com' } },
  ],
});
```

### Environment-based Configuration

```typescript
import { environment } from './environments/environment';

@NgModule({
  providers: [
    TentickleService,
    {
      provide: TENTICKLE_CONFIG,
      useValue: {
        baseUrl: environment.tentickleUrl,
        token: environment.tentickleToken,
      },
    },
  ],
})
export class AppModule {}
```

### Factory Provider

```typescript
@NgModule({
  providers: [
    TentickleService,
    {
      provide: TENTICKLE_CONFIG,
      useFactory: (auth: AuthService) => ({
        baseUrl: 'https://api.example.com',
        token: auth.getToken(),
      }),
      deps: [AuthService],
    },
  ],
})
export class AppModule {}
```

## Usage Patterns

### Basic Component

```typescript
@Component({
  selector: 'app-chat',
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

### With Error Handling

```typescript
@Component({
  template: `
    @if (session$ | async; as session) {
      @if (session.error) {
        <div class="error">{{ session.error.message }}</div>
        <button (click)="retry()">Retry</button>
      }
    }
  `,
})
export class ChatComponent {
  private tentickle = inject(TentickleService);
  session$ = this.tentickle.session$;

  async retry() {
    await this.tentickle.disconnect();
    await this.tentickle.connect();
  }
}
```

### Subscribing to Events

```typescript
@Component({...})
export class ToolMonitorComponent implements OnInit, OnDestroy {
  private tentickle = inject(TentickleService);
  private destroy$ = new Subject<void>();

  ngOnInit() {
    this.tentickle.eventsOfType('tool_call', 'tool_result')
      .pipe(takeUntil(this.destroy$))
      .subscribe(event => {
        console.log('Tool event:', event);
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
```

### Using Channels

```typescript
@Component({...})
export class TodoComponent implements OnInit {
  private tentickle = inject(TentickleService);

  todos$ = this.tentickle.channel$('todos').pipe(
    filter(e => e.type === 'updated'),
    map(e => e.payload as Todo[])
  );

  async addTodo(title: string) {
    const channel = this.tentickle.channel('todos');
    await channel.publish('add', { title });
  }
}
```

## Observable Reference

| Observable | Type | Description |
|------------|------|-------------|
| `session$` | `SessionState` | Full session state |
| `connectionState$` | `ConnectionState` | Connection state only |
| `isConnected$` | `boolean` | Whether connected |
| `events$` | `StreamEvent` | All stream events |
| `streamingText$` | `StreamingTextState` | Text + isStreaming |
| `text$` | `string` | Just the accumulated text |
| `isStreaming$` | `boolean` | Whether streaming |
| `result$` | `Result` | Execution results |

## Method Reference

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

## Lifecycle Management

The service implements `OnDestroy` to clean up resources:

```typescript
ngOnDestroy(): void {
  this.destroy$.next();
  this.destroy$.complete();
  this.client.destroy();
}
```

All channel observables created via `channel$()` automatically complete when the service is destroyed via `takeUntil(this.destroy$)`.

## Synchronous Getters

For imperative code, synchronous getters are available:

```typescript
const service = inject(TentickleService);

// Synchronous access to current values
if (service.isConnected) {
  console.log('Session ID:', service.sessionId);
  console.log('Full state:', service.session);
}
```

## Type Exports

```typescript
// Service and token
export { TentickleService, TENTICKLE_CONFIG } from "./tentickle.service.js";

// Types
export type {
  TentickleConfig,
  SessionState,
  StreamingTextState,
  TentickleClient,
  ConnectionState,
  StreamEvent,
} from "./types.js";
```
