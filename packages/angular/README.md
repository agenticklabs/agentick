# @agentick/angular

Angular integration for Agentick. Provides signal-first service wrappers around `@agentick/client`.

## Installation

```bash
pnpm add @agentick/angular
```

## Quick Start — ChatSessionService

For chat UIs, use `ChatSessionService` with `provideChatSession()`. This wraps `ChatSession` from `@agentick/client` and exposes all state as Angular signals.

```ts
import { Component, inject } from "@angular/core";
import { ChatSessionService, provideChatSession, provideAgentick } from "@agentick/angular";

@Component({
  selector: "app-chat",
  standalone: true,
  providers: [
    provideAgentick({ baseUrl: "/api/v2", token: myJwt }),
    provideChatSession({ renderMode: "streaming" }),
  ],
  template: `
    @for (msg of chat.messages(); track msg.id) {
      <div>{{ msg.role }}: {{ msg.content }}</div>
    }
    <input #input />
    <button (click)="chat.submit(input.value); input.value = ''">Send</button>
  `,
})
export class ChatComponent {
  chat = inject(ChatSessionService);
}
```

### ChatSessionService Signals

```ts
chat.messages()          // readonly ChatMessage[]
chat.chatMode()          // "idle" | "streaming" | "confirming_tool"
chat.isExecuting()       // boolean
chat.toolConfirmation()  // ToolConfirmationState | null
chat.lastSubmitted()     // string | null
chat.queued()            // readonly Message[]
chat.mode()              // "steer" | "queue"
chat.error()             // { message, name } | null
chat.attachments()       // readonly Attachment[]

// Computed
chat.isIdle()            // boolean
chat.isStreaming()       // boolean
chat.isConfirmingTool()  // boolean
```

### ChatSessionService Actions

```ts
chat.submit(text)                    // Send message
chat.steer(text)                     // Force send immediately
chat.queue(text)                     // Queue for next execution
chat.interrupt(text)                 // Abort current + send
chat.abort(reason?)                  // Abort current execution
chat.flush()                         // Flush next queued message
chat.respondToConfirmation(response) // Approve/deny tool
chat.clearMessages()                 // Clear all messages
chat.prependMessages(messages)       // Load older history (scroll-back)
chat.appendMessages(messages)        // Initial load or external sources
chat.setMode(mode)                   // Switch steer/queue mode

// Attachments
chat.addAttachment(input)            // Add file
chat.removeAttachment(id)            // Remove file
chat.clearAttachments()              // Clear all files
```

### Paginated History

Load older messages as the user scrolls back:

```ts
async loadOlderMessages(cursor: string) {
  const res = await fetch(`/api/messages?before=${cursor}&limit=20`);
  const { messages } = await res.json();
  this.chat.prependMessages(messages);
}
```

### ChatSessionOptions

```ts
provideChatSession({
  sessionId: "conv-123",          // Connect to existing session
  initialMessages: [],            // Pre-loaded messages from DB
  renderMode: "streaming",        // "streaming" | "block" | "message"
  confirmationPolicy: undefined,  // Auto-approve/deny policy
  autoSubscribe: true,            // Subscribe on construction (default)
})
```

## AgentickService (Low-Level)

For direct client access (sessions, channels, raw events), use `AgentickService`:

```ts
import { Component, inject } from "@angular/core";
import { AgentickService, provideAgentick } from "@agentick/angular";

@Component({
  selector: "app-chat",
  providers: [provideAgentick({ baseUrl: "/api/agent" })],
  template: `
    <div>{{ agentick.text() }}</div>
    <button (click)="send('Hello')">Send</button>
  `,
})
export class ChatComponent {
  agentick = inject(AgentickService);

  constructor() {
    this.agentick.subscribe("conv-123");
  }

  send(message: string) {
    this.agentick.send(message);
  }
}
```

### AgentickService API

```ts
// Session management
service.session(sessionId)      // Cold accessor
service.subscribe(sessionId)    // Hot accessor
service.unsubscribe()           // Drop current subscription

// Messaging
service.send(input)             // Returns ClientExecutionHandle
service.abort(reason?)
service.close()
service.clearStreamingText()

// Channels
service.channel(name)           // Session-scoped channel
service.channel$(name)          // Channel as Observable
service.eventsOfType(...types)  // Filtered event Observable
```

### Signals

```ts
service.connectionState()  // "disconnected" | "connecting" | "connected" | "error"
service.sessionId()        // string | undefined
service.streamingText()    // { text, isStreaming }
service.text()             // string (computed)
service.isStreaming()       // boolean (computed)
service.isConnected()      // boolean (computed)
service.isConnecting()     // boolean (computed)
```

### RxJS Observables

All signals are also available as observables via `toObservable()`:

```ts
service.connectionState$
service.isConnected$
service.streamingText$
service.text$
service.isStreaming$
service.events$
```

## Provider Pattern

Both services require `provideAgentick()` at the component level. Each provider creates an isolated instance with its own client and connection:

```ts
// Two independent chat agents in the same app
@Component({
  providers: [provideAgentick({ baseUrl: "/api/support" })],
})
export class SupportChat { ... }

@Component({
  providers: [provideAgentick({ baseUrl: "/api/sales" })],
})
export class SalesChat { ... }
```
