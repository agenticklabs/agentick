# @agentick/angular

Angular integration for Agentick. Provides a signal-first service wrapper around `@agentick/client`.

## Installation

```bash
pnpm add @agentick/angular
```

## Quick Start

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

  async send(message: string) {
    const handle = this.agentick.send(message);
    await handle.result;
  }
}
```

## Service API

```ts
service.session(sessionId)      // cold accessor
service.subscribe(sessionId)    // hot accessor
service.unsubscribe()           // drop current subscription

service.send(input)             // returns ClientExecutionHandle
service.abort(reason?)
service.close()

service.channel(name)           // session-scoped channel
```

Signals:

```ts
service.connectionState()
service.sessionId()
service.streamingText()
service.text()
service.isStreaming()
```
