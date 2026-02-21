/**
 * @agentick/angular - Modern Angular bindings for Agentick
 *
 * Uses Angular signals for reactive state with RxJS interop for compatibility.
 *
 * @example Standalone setup
 * ```typescript
 * import { TENTICKLE_CONFIG } from '@agentick/angular';
 *
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     { provide: TENTICKLE_CONFIG, useValue: { baseUrl: 'https://api.example.com' } },
 *   ],
 * });
 * ```
 *
 * @example Component with signals (recommended)
 * ```typescript
 * import { Component, inject } from '@angular/core';
 * import { AgentickService } from '@agentick/angular';
 *
 * @Component({
 *   selector: 'app-chat',
 *   standalone: true,
 *   template: `
 *     <div class="response">
 *       {{ agentick.text() }}
 *       @if (agentick.isStreaming()) {
 *         <span class="cursor">|</span>
 *       }
 *     </div>
 *     <input #input />
 *     <button (click)="send(input.value); input.value = ''">Send</button>
 *   `,
 * })
 * export class ChatComponent {
 *   agentick = inject(AgentickService);
 *
 *   constructor() {
 *     this.agentick.subscribe("conv-123");
 *   }
 *
 *   async send(message: string) {
 *     const handle = this.agentick.send(message);
 *     await handle.result;
 *   }
 * }
 * ```
 *
 * @example With RxJS (for legacy or complex reactive flows)
 * ```typescript
 * @Component({
 *   template: `
 *     <div>{{ text$ | async }}</div>
 *   `,
 * })
 * export class LegacyComponent {
 *   agentick = inject(AgentickService);
 *   text$ = this.agentick.text$;
 * }
 * ```
 *
 * @example Multiple agents with separate instances
 * ```typescript
 * import { provideAgentick, AgentickService } from '@agentick/angular';
 *
 * // Each component gets its own service instance
 * @Component({
 *   selector: 'app-support-chat',
 *   standalone: true,
 *   providers: [provideAgentick({ baseUrl: '/api/support-agent' })],
 *   template: `<div>{{ agentick.text() }}</div>`,
 * })
 * export class SupportChatComponent {
 *   agentick = inject(AgentickService);
 * }
 *
 * @Component({
 *   selector: 'app-sales-chat',
 *   standalone: true,
 *   providers: [provideAgentick({ baseUrl: '/api/sales-agent' })],
 *   template: `<div>{{ agentick.text() }}</div>`,
 * })
 * export class SalesChatComponent {
 *   agentick = inject(AgentickService);
 * }
 * ```
 *
 * ## Signals (Primary API)
 *
 * | Signal | Type | Description |
 * |--------|------|-------------|
 * | `connectionState()` | `ConnectionState` | Connection state |
 * | `sessionId()` | `string \| undefined` | Active session ID |
 * | `streamingText()` | `StreamingTextState` | Text + isStreaming |
 * | `text()` | `string` | Just the text (computed) |
 * | `isStreaming()` | `boolean` | Whether streaming (computed) |
 *
 * ## RxJS Observables (Compatibility)
 *
 * | Observable | Type | Description |
 * |------------|------|-------------|
 * | `connectionState$` | `ConnectionState` | Connection state |
 * | `isConnected$` | `boolean` | Whether connected |
 * | `streamingText$` | `StreamingTextState` | Text + isStreaming |
 * | `text$` | `string` | Just the text |
 * | `isStreaming$` | `boolean` | Whether streaming |
 * | `events$` | `StreamEvent | SessionStreamEvent` | All stream events |
 * | `result$` | `Result` | Execution results |
 *
 * ## Methods
 *
 * | Method | Description |
 * |--------|-------------|
 * | `session(sessionId)` | Get cold accessor |
 * | `subscribe(sessionId)` | Subscribe (hot) |
 * | `unsubscribe()` | Unsubscribe active session |
 * | `send(input)` | Send message |
 * | `abort(reason?)` | Abort execution |
 * | `close()` | Close active session |
 * | `channel(name)` | Get channel accessor |
 * | `channel$(name)` | Get channel as Observable |
 * | `eventsOfType(...types)` | Filter events by type |
 * | `clearStreamingText()` | Clear accumulated text |
 *
 * @module @agentick/angular
 */

// Service, token, and provider factory
export { AgentickService, TENTICKLE_CONFIG, provideAgentick } from "./agentick.service.js";

// Types
export type {
  AgentickConfig,
  TransportConfig,
  AgentickClient,
  ConnectionState,
  StreamEvent,
  SessionStreamEvent,
  ClientExecutionHandle,
  StreamingTextState,
  ClientTransport,
} from "./types.js";

// Re-export createClient for advanced usage
export { createClient } from "@agentick/client";
