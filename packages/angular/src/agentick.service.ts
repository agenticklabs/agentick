/**
 * AgentickService - Modern Angular service for Agentick.
 *
 * Uses Angular signals for reactive state management with RxJS interop.
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
import { Observable, Subject, filter, takeUntil } from "rxjs";
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
import type { AgentickConfig } from "./types";

/**
 * Injection token for Agentick configuration.
 */
export const TENTICKLE_CONFIG = new InjectionToken<AgentickConfig>("TENTICKLE_CONFIG");

/**
 * Provides AgentickService with configuration at component level.
 *
 * Use this to create isolated service instances for different components,
 * each with their own connection and state.
 *
 * @example Multiple agents in one app
 * ```typescript
 * // Each component gets its own AgentickService instance
 *
 * @Component({
 *   selector: 'app-support-chat',
 *   providers: [provideAgentick({ baseUrl: '/api/support-agent' })],
 *   template: `<div>{{ agentick.text() }}</div>`,
 * })
 * export class SupportChatComponent {
 *   agentick = inject(AgentickService);
 * }
 *
 * @Component({
 *   selector: 'app-sales-chat',
 *   providers: [provideAgentick({ baseUrl: '/api/sales-agent' })],
 *   template: `<div>{{ agentick.text() }}</div>`,
 * })
 * export class SalesChatComponent {
 *   agentick = inject(AgentickService);
 * }
 * ```
 *
 * @param config - Configuration for this service instance
 * @returns Provider array to spread into component's providers
 */
export function provideAgentick(config: AgentickConfig) {
  return [{ provide: TENTICKLE_CONFIG, useValue: config }, AgentickService];
}

/**
 * Modern Angular service for Agentick.
 *
 * Uses signals for state, with RxJS observables available for compatibility.
 *
 * @example Standalone setup
 * ```typescript
 * import { AgentickService, TENTICKLE_CONFIG } from '@agentick/angular';
 *
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     { provide: TENTICKLE_CONFIG, useValue: { baseUrl: 'https://api.example.com' } },
 *   ],
 * });
 * ```
 *
 * @example Component with signals
 * ```typescript
 * @Component({
 *   template: `
 *     @if (agentick.isConnected()) {
 *       <div class="response">
 *         {{ agentick.text() }}
 *         @if (agentick.isStreaming()) {
 *           <span class="cursor">|</span>
 *         }
 *       </div>
 *       <input #input />
 *       <button (click)="send(input.value)">Send</button>
 *     } @else {
 *       <p>Connecting...</p>
 *     }
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
 * @example With RxJS (for compatibility)
 * ```typescript
 * @Component({
 *   template: `{{ text$ | async }}`,
 * })
 * export class LegacyComponent {
 *   agentick = inject(AgentickService);
 *   text$ = this.agentick.text$;
 * }
 * ```
 */
@Injectable({ providedIn: "root" })
export class AgentickService implements OnDestroy {
  private readonly client: AgentickClient;
  private readonly destroy$ = new Subject<void>();
  private currentSession?: SessionAccessor;

  // ══════════════════════════════════════════════════════════════════════════
  // Signals - Primary State
  // ══════════════════════════════════════════════════════════════════════════

  /** Current connection state */
  readonly connectionState = signal<ConnectionState>("disconnected");

  /** Current session ID */
  readonly sessionId = signal<string | undefined>(undefined);

  /** Connection error, if any */
  readonly error = signal<Error | undefined>(undefined);

  /** Streaming text state from the client */
  readonly streamingText = signal<StreamingTextState>({ text: "", isStreaming: false });

  // ══════════════════════════════════════════════════════════════════════════
  // Computed Signals - Derived State
  // ══════════════════════════════════════════════════════════════════════════

  /** Whether currently connected */
  readonly isConnected = computed(() => this.connectionState() === "connected");

  /** Whether currently connecting */
  readonly isConnecting = computed(() => this.connectionState() === "connecting");

  /** Current streaming text */
  readonly text = computed(() => this.streamingText().text);

  /** Whether currently streaming */
  readonly isStreaming = computed(() => this.streamingText().isStreaming);

  // ══════════════════════════════════════════════════════════════════════════
  // RxJS Observables - For Compatibility
  // ══════════════════════════════════════════════════════════════════════════

  /** Observable of connection state (for RxJS users) */
  readonly connectionState$: Observable<ConnectionState>;

  /** Observable of whether connected (for RxJS users) */
  readonly isConnected$: Observable<boolean>;

  /** Observable of streaming text state (for RxJS users) */
  readonly streamingText$: Observable<StreamingTextState>;

  /** Observable of just the text (for RxJS users) */
  readonly text$: Observable<string>;

  /** Observable of whether streaming (for RxJS users) */
  readonly isStreaming$: Observable<boolean>;

  /** Subject for raw stream events */
  private readonly eventsSubject = new Subject<StreamEvent | SessionStreamEvent>();

  /** Observable of all stream events */
  readonly events$ = this.eventsSubject.asObservable();

  /** Subject for execution results */
  private readonly resultSubject = new Subject<{
    response: string;
    outputs: Record<string, unknown>;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    stopReason?: string;
  }>();

  /** Observable of execution results */
  readonly result$ = this.resultSubject.asObservable();

  // ══════════════════════════════════════════════════════════════════════════
  // Constructor
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Creates a new AgentickService.
   *
   * @param configOrInjected - Config passed directly (for testing) or undefined to use DI
   */
  constructor(configOrInjected?: AgentickConfig) {
    // Support both direct config (for testing) and DI injection
    let config = configOrInjected;
    if (!config) {
      try {
        config = inject(TENTICKLE_CONFIG, { optional: true }) ?? undefined;
      } catch {
        // Not in injection context - config must be passed directly
      }
    }

    if (!config) {
      throw new Error("AgentickService requires TENTICKLE_CONFIG to be provided");
    }

    this.client = createClient(config);

    // Initialize observables from signals
    // Note: toObservable requires injection context, so we create them conditionally
    try {
      this.connectionState$ = toObservable(this.connectionState);
      this.isConnected$ = toObservable(this.isConnected);
      this.streamingText$ = toObservable(this.streamingText);
      this.text$ = toObservable(this.text);
      this.isStreaming$ = toObservable(this.isStreaming);
    } catch {
      // Not in injection context - create manual observables for testing
      this.connectionState$ = new Observable<ConnectionState>((subscriber) => {
        subscriber.next(this.connectionState());
        const interval = setInterval(() => {
          subscriber.next(this.connectionState());
        }, 10);
        return () => clearInterval(interval);
      });
      this.isConnected$ = new Observable<boolean>((subscriber) => {
        subscriber.next(this.isConnected());
        const interval = setInterval(() => {
          subscriber.next(this.isConnected());
        }, 10);
        return () => clearInterval(interval);
      });
      this.streamingText$ = new Observable<StreamingTextState>((subscriber) => {
        subscriber.next(this.streamingText());
        const interval = setInterval(() => {
          subscriber.next(this.streamingText());
        }, 10);
        return () => clearInterval(interval);
      });
      this.text$ = new Observable<string>((subscriber) => {
        subscriber.next(this.text());
        const interval = setInterval(() => {
          subscriber.next(this.text());
        }, 10);
        return () => clearInterval(interval);
      });
      this.isStreaming$ = new Observable<boolean>((subscriber) => {
        subscriber.next(this.isStreaming());
        const interval = setInterval(() => {
          subscriber.next(this.isStreaming());
        }, 10);
        return () => clearInterval(interval);
      });
    }

    this.setupSubscriptions();
  }

  private setupSubscriptions(): void {
    // Connection state → signal
    this.client.onConnectionChange((state) => {
      this.connectionState.set(state);
    });

    // Streaming text → signal
    this.client.onStreamingText((state) => {
      this.streamingText.set(state);
    });

    // Events → subject (for filtering)
    this.client.onEvent((event) => {
      this.eventsSubject.next(event);
    });

    // Results → subject
    this.client.onEvent((event) => {
      if (event.type === "result") {
        this.resultSubject.next(event.result);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Session Access
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get a cold session accessor.
   */
  session(sessionId: string): SessionAccessor {
    return this.client.session(sessionId);
  }

  /**
   * Subscribe to a session and make it the active session.
   */
  subscribe(sessionId: string): SessionAccessor {
    const accessor = this.client.subscribe(sessionId);
    this.currentSession = accessor;
    this.sessionId.set(sessionId);
    return accessor;
  }

  /**
   * Unsubscribe from the active session.
   */
  unsubscribe(): void {
    this.currentSession?.unsubscribe();
    this.currentSession = undefined;
    this.sessionId.set(undefined);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Messaging
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send a message to the session.
   */
  send(input: Parameters<AgentickClient["send"]>[0]): ClientExecutionHandle {
    if (this.currentSession) {
      return this.currentSession.send(input as any);
    }
    return this.client.send(input as any);
  }

  /**
   * Abort the current execution.
   */
  async abort(reason?: string): Promise<void> {
    if (this.currentSession) {
      await this.currentSession.abort(reason);
      return;
    }
    const id = this.sessionId();
    if (id) {
      await this.client.abort(id, reason);
    }
  }

  /**
   * Close the active session on the server.
   */
  async close(): Promise<void> {
    if (this.currentSession) {
      await this.currentSession.close();
      this.currentSession = undefined;
      this.sessionId.set(undefined);
    }
  }

  /**
   * Clear the accumulated streaming text.
   */
  clearStreamingText(): void {
    this.client.clearStreamingText();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Channels
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get a channel accessor for custom pub/sub.
   */
  channel(name: string) {
    if (!this.currentSession) {
      throw new Error("No active session. Call subscribe(sessionId) first.");
    }
    return this.currentSession.channel(name);
  }

  /**
   * Create an Observable from a channel.
   */
  channel$(name: string): Observable<{ type: string; payload: unknown }> {
    return new Observable<{ type: string; payload: unknown }>((subscriber) => {
      const channel = this.channel(name);
      const unsubscribe = channel.subscribe((payload, event) => {
        subscriber.next({ type: event.type, payload });
      });
      return () => unsubscribe();
    }).pipe(takeUntil(this.destroy$));
  }

  /**
   * Filter events by type.
   */
  eventsOfType(...types: StreamEvent["type"][]): Observable<StreamEvent> {
    return this.events$.pipe(filter((event) => types.includes(event.type)));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Cleanup
  // ══════════════════════════════════════════════════════════════════════════

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.client.destroy();
  }
}
