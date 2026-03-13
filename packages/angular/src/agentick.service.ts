/**
 * AgentickService — Angular service wrapping AgentickClient with signals.
 *
 * Provides reactive state (signals) for connection, streaming text, and events.
 * RxJS observables derived from signals for compatibility.
 *
 * @module @agentick/angular/service
 */

import {
  Injectable,
  InjectionToken,
  type OnDestroy,
  computed,
  signal,
  inject,
} from "@angular/core";
import { toObservable } from "@angular/core/rxjs-interop";
import { Observable, Subject } from "rxjs";
import {
  createClient,
  type AgentickClient,
  type ConnectionState,
  type StreamEvent,
  type StreamingTextState,
  type SessionStreamEvent,
  type SessionAccessor,
  type ClientExecutionHandle,
} from "@agentick/client";
import type { AgentickConfig } from "./types.js";

/**
 * Injection token for Agentick configuration.
 */
export const TENTICKLE_CONFIG = new InjectionToken<AgentickConfig>("TENTICKLE_CONFIG");

/**
 * Provides AgentickService with configuration at component level.
 *
 * Creates an isolated service instance per component, each with its own
 * connection and state.
 *
 * @example
 * ```typescript
 * @Component({
 *   providers: [provideAgentick({ baseUrl: '/api/v2', token: myJwt })],
 *   template: `<div>{{ agentick.text() }}</div>`,
 * })
 * export class ChatComponent {
 *   agentick = inject(AgentickService);
 * }
 * ```
 */
export function provideAgentick(config: AgentickConfig) {
  return [{ provide: TENTICKLE_CONFIG, useValue: config }, AgentickService];
}

/**
 * Angular service wrapping `AgentickClient` with signals.
 *
 * Lower-level than `ChatSessionService` — use this when you need direct
 * client access (sessions, channels, raw events). For chat UIs, prefer
 * `ChatSessionService` which composes higher-level chat primitives.
 *
 * @example
 * ```typescript
 * @Component({
 *   providers: [provideAgentick({ baseUrl: '/api/v2' })],
 *   template: `
 *     @if (agentick.isConnected()) {
 *       <div>{{ agentick.text() }}</div>
 *       <button (click)="send('hello')">Send</button>
 *     }
 *   `,
 * })
 * export class ChatComponent {
 *   agentick = inject(AgentickService);
 *
 *   constructor() {
 *     this.agentick.subscribe('session-123');
 *   }
 *
 *   send(text: string) {
 *     this.agentick.send(text);
 *   }
 * }
 * ```
 */
@Injectable()
export class AgentickService implements OnDestroy {
  private readonly client: AgentickClient;
  private readonly _cleanups: (() => void)[] = [];
  private _currentSession?: SessionAccessor;

  // ══════════════════════════════════════════════════════════════════════════
  // Signals
  // ══════════════════════════════════════════════════════════════════════════

  readonly connectionState = signal<ConnectionState>("disconnected");
  readonly sessionId = signal<string | undefined>(undefined);
  readonly streamingText = signal<StreamingTextState>({ text: "", isStreaming: false });

  // Computed
  readonly isConnected = computed(() => this.connectionState() === "connected");
  readonly isConnecting = computed(() => this.connectionState() === "connecting");
  readonly text = computed(() => this.streamingText().text);
  readonly isStreaming = computed(() => this.streamingText().isStreaming);

  // ══════════════════════════════════════════════════════════════════════════
  // RxJS Observables (derived from signals)
  // ══════════════════════════════════════════════════════════════════════════

  readonly connectionState$ = toObservable(this.connectionState);
  readonly isConnected$ = toObservable(this.isConnected);
  readonly streamingText$ = toObservable(this.streamingText);
  readonly text$ = toObservable(this.text);
  readonly isStreaming$ = toObservable(this.isStreaming);

  private readonly _events$ = new Subject<StreamEvent | SessionStreamEvent>();
  readonly events$ = this._events$.asObservable();

  // ══════════════════════════════════════════════════════════════════════════
  // Constructor
  // ══════════════════════════════════════════════════════════════════════════

  constructor() {
    const config = inject(TENTICKLE_CONFIG);
    this.client = createClient(config);

    this._cleanups.push(
      this.client.onConnectionChange((state) => this.connectionState.set(state)),
      this.client.onStreamingText((state) => this.streamingText.set(state)),
      this.client.onEvent((event) => this._events$.next(event)),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Session
  // ══════════════════════════════════════════════════════════════════════════

  session(sessionId: string): SessionAccessor {
    return this.client.session(sessionId);
  }

  subscribe(sessionId: string): SessionAccessor {
    const accessor = this.client.subscribe(sessionId);
    this._currentSession = accessor;
    this.sessionId.set(sessionId);
    return accessor;
  }

  unsubscribe(): void {
    this._currentSession?.unsubscribe();
    this._currentSession = undefined;
    this.sessionId.set(undefined);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Messaging
  // ══════════════════════════════════════════════════════════════════════════

  send(input: Parameters<AgentickClient["send"]>[0]): ClientExecutionHandle {
    if (this._currentSession) {
      return this._currentSession.send(input as Parameters<SessionAccessor["send"]>[0]);
    }
    return this.client.send(input);
  }

  abort(reason?: string): void {
    this._currentSession?.abort(reason);
  }

  async close(): Promise<void> {
    if (this._currentSession) {
      await this._currentSession.close();
      this._currentSession = undefined;
      this.sessionId.set(undefined);
    }
  }

  clearStreamingText(): void {
    this.client.clearStreamingText();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Channels
  // ══════════════════════════════════════════════════════════════════════════

  channel(name: string) {
    if (!this._currentSession) {
      throw new Error("No active session. Call subscribe(sessionId) first.");
    }
    return this._currentSession.channel(name);
  }

  channel$(name: string): Observable<{ type: string; payload: unknown }> {
    const ch = this.channel(name);
    return new Observable((subscriber) => {
      const unsub = ch.subscribe((payload, event) => {
        subscriber.next({ type: event.type, payload });
      });
      return unsub;
    });
  }

  eventsOfType<T extends StreamEvent["type"]>(...types: T[]) {
    return new Observable<Extract<StreamEvent, { type: T }>>((subscriber) => {
      const sub = this._events$.subscribe((event) => {
        if (types.includes(event.type as T)) {
          subscriber.next(event as Extract<StreamEvent, { type: T }>);
        }
      });
      return () => sub.unsubscribe();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  ngOnDestroy(): void {
    for (const cleanup of this._cleanups) cleanup();
    this._events$.complete();
    this.client.destroy();
  }
}
