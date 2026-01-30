/**
 * @tentickle/angular - Modern Angular bindings for Tentickle
 *
 * Uses Angular signals for reactive state with RxJS interop for compatibility.
 *
 * @example Standalone setup
 * ```typescript
 * import { TENTICKLE_CONFIG } from '@tentickle/angular';
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
 * import { TentickleService } from '@tentickle/angular';
 *
 * @Component({
 *   selector: 'app-chat',
 *   standalone: true,
 *   template: `
 *     <div class="response">
 *       {{ tentickle.text() }}
 *       @if (tentickle.isStreaming()) {
 *         <span class="cursor">|</span>
 *       }
 *     </div>
 *     <input #input />
 *     <button (click)="send(input.value); input.value = ''">Send</button>
 *   `,
 * })
 * export class ChatComponent {
 *   tentickle = inject(TentickleService);
 *
 *   constructor() {
 *     this.tentickle.subscribe("conv-123");
 *   }
 *
 *   async send(message: string) {
 *     const handle = this.tentickle.send(message);
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
 *   tentickle = inject(TentickleService);
 *   text$ = this.tentickle.text$;
 * }
 * ```
 *
 * @example Multiple agents with separate instances
 * ```typescript
 * import { provideTentickle, TentickleService } from '@tentickle/angular';
 *
 * // Each component gets its own service instance
 * @Component({
 *   selector: 'app-support-chat',
 *   standalone: true,
 *   providers: [provideTentickle({ baseUrl: '/api/support-agent' })],
 *   template: `<div>{{ tentickle.text() }}</div>`,
 * })
 * export class SupportChatComponent {
 *   tentickle = inject(TentickleService);
 * }
 *
 * @Component({
 *   selector: 'app-sales-chat',
 *   standalone: true,
 *   providers: [provideTentickle({ baseUrl: '/api/sales-agent' })],
 *   template: `<div>{{ tentickle.text() }}</div>`,
 * })
 * export class SalesChatComponent {
 *   tentickle = inject(TentickleService);
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
 * @module @tentickle/angular
 */

// Service, token, and provider factory
export { TentickleService, TENTICKLE_CONFIG, provideTentickle } from "./tentickle.service";

// Types
export type {
  TentickleConfig,
  TentickleClient,
  ConnectionState,
  StreamEvent,
  SessionStreamEvent,
  ClientExecutionHandle,
  StreamingTextState,
} from "./types";
