# @tentickle/angular

Angular integration for Tentickle. Provides a signal-first service wrapper around `@tentickle/client`.

## Installation

```bash
pnpm add @tentickle/angular
```

## Quick Start

```ts
import { Component, inject } from "@angular/core";
import { TentickleService, provideTentickle } from "@tentickle/angular";

@Component({
  selector: "app-chat",
  providers: [provideTentickle({ baseUrl: "/api/agent" })],
  template: `
    <div>{{ tentickle.text() }}</div>
    <button (click)="send('Hello')">Send</button>
  `,
})
export class ChatComponent {
  tentickle = inject(TentickleService);

  constructor() {
    this.tentickle.subscribe("conv-123");
  }

  async send(message: string) {
    const handle = this.tentickle.send(message);
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
