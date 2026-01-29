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
 *     @if (tentickle.isConnected()) {
 *       <div class="response">
 *         {{ tentickle.text() }}
 *         @if (tentickle.isStreaming()) {
 *           <span class="cursor">|</span>
 *         }
 *       </div>
 *       <input #input />
 *       <button (click)="send(input.value); input.value = ''">Send</button>
 *     } @else if (tentickle.isConnecting()) {
 *       <p>Connecting...</p>
 *     }
 *   `,
 * })
 * export class ChatComponent {
 *   tentickle = inject(TentickleService);
 *
 *   constructor() {
 *     this.tentickle.connect();
 *   }
 *
 *   async send(message: string) {
 *     await this.tentickle.send(message);
 *     await this.tentickle.tick();
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
 * | `connectionState()` | `ConnectionState` | Current connection state |
 * | `sessionId()` | `string \| undefined` | Current session ID |
 * | `isConnected()` | `boolean` | Whether connected (computed) |
 * | `isConnecting()` | `boolean` | Whether connecting (computed) |
 * | `error()` | `Error \| undefined` | Connection error |
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
 * | `events$` | `StreamEvent` | All stream events |
 * | `result$` | `Result` | Execution results |
 *
 * ## Methods
 *
 * | Method | Description |
 * |--------|-------------|
 * | `connect(sessionId?, props?)` | Connect to session |
 * | `disconnect()` | Disconnect |
 * | `send(content)` | Send message |
 * | `tick(props?)` | Trigger tick |
 * | `abort(reason?)` | Abort execution |
 * | `channel(name)` | Get channel accessor |
 * | `channel$(name)` | Get channel as Observable |
 * | `eventsOfType(...types)` | Filter events by type |
 * | `clearStreamingText()` | Clear accumulated text |
 *
 * @module @tentickle/angular
 */

// Service, token, and provider factory
export {
  TentickleService,
  TENTICKLE_CONFIG,
  provideTentickle,
} from "./tentickle.service.js";

// Types
export type {
  TentickleConfig,
  TentickleClient,
  ConnectionState,
  StreamEvent,
  StreamingTextState,
} from "./types.js";
