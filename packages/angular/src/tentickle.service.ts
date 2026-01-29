/**
 * TentickleService - Modern Angular service for Tentickle.
 *
 * Uses Angular signals for reactive state management with RxJS interop.
 *
 * @module @tentickle/angular/service
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
  type TentickleClient,
  type ConnectionState,
  type StreamEvent,
  type StreamingTextState,
} from "@tentickle/client";
import type { TentickleConfig } from "./types.js";

/**
 * Injection token for Tentickle configuration.
 */
export const TENTICKLE_CONFIG = new InjectionToken<TentickleConfig>(
  "TENTICKLE_CONFIG",
);

/**
 * Provides TentickleService with configuration at component level.
 *
 * Use this to create isolated service instances for different components,
 * each with their own connection and state.
 *
 * @example Multiple agents in one app
 * ```typescript
 * // Each component gets its own TentickleService instance
 *
 * @Component({
 *   selector: 'app-support-chat',
 *   providers: [provideTentickle({ baseUrl: '/api/support-agent' })],
 *   template: `<div>{{ tentickle.text() }}</div>`,
 * })
 * export class SupportChatComponent {
 *   tentickle = inject(TentickleService);
 * }
 *
 * @Component({
 *   selector: 'app-sales-chat',
 *   providers: [provideTentickle({ baseUrl: '/api/sales-agent' })],
 *   template: `<div>{{ tentickle.text() }}</div>`,
 * })
 * export class SalesChatComponent {
 *   tentickle = inject(TentickleService);
 * }
 * ```
 *
 * @param config - Configuration for this service instance
 * @returns Provider array to spread into component's providers
 */
export function provideTentickle(config: TentickleConfig) {
  return [
    { provide: TENTICKLE_CONFIG, useValue: config },
    TentickleService,
  ];
}

/**
 * Modern Angular service for Tentickle.
 *
 * Uses signals for state, with RxJS observables available for compatibility.
 *
 * @example Standalone setup
 * ```typescript
 * import { TentickleService, TENTICKLE_CONFIG } from '@tentickle/angular';
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
 *     @if (tentickle.isConnected()) {
 *       <div class="response">
 *         {{ tentickle.text() }}
 *         @if (tentickle.isStreaming()) {
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
 * @example With RxJS (for compatibility)
 * ```typescript
 * @Component({
 *   template: `{{ text$ | async }}`,
 * })
 * export class LegacyComponent {
 *   tentickle = inject(TentickleService);
 *   text$ = this.tentickle.text$;
 * }
 * ```
 */
@Injectable({ providedIn: "root" })
export class TentickleService implements OnDestroy {
  private readonly client: TentickleClient;
  private readonly destroy$ = new Subject<void>();

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
  private readonly eventsSubject = new Subject<StreamEvent>();

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
   * Creates a new TentickleService.
   *
   * @param configOrInjected - Config passed directly (for testing) or undefined to use DI
   */
  constructor(configOrInjected?: TentickleConfig) {
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
      throw new Error(
        "TentickleService requires TENTICKLE_CONFIG to be provided",
      );
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
    this.client.onResult((result) => {
      this.resultSubject.next(result);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Connection Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Connect to a session.
   *
   * Creates a new session if no sessionId provided.
   */
  async connect(sessionId?: string, props?: Record<string, unknown>): Promise<void> {
    if (this.isConnected() || this.isConnecting()) {
      return;
    }

    this.connectionState.set("connecting");
    this.error.set(undefined);

    try {
      let targetSessionId = sessionId;

      if (!targetSessionId) {
        const result = await this.client.createSession({ props });
        targetSessionId = result.sessionId;
      }

      this.sessionId.set(targetSessionId);
      await this.client.connect(targetSessionId);
    } catch (e) {
      this.connectionState.set("error");
      this.error.set(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  /**
   * Disconnect from the current session.
   */
  async disconnect(): Promise<void> {
    try {
      await this.client.disconnect();
      this.connectionState.set("disconnected");
      this.sessionId.set(undefined);
    } catch (e) {
      this.error.set(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Messaging
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send a message to the session.
   */
  async send(content: string): Promise<void> {
    await this.client.send(content);
  }

  /**
   * Trigger a tick with optional props.
   */
  async tick(props?: Record<string, unknown>): Promise<void> {
    await this.client.tick(props);
  }

  /**
   * Abort the current execution.
   */
  async abort(reason?: string): Promise<void> {
    await this.client.abort(reason);
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
    return this.client.channel(name);
  }

  /**
   * Create an Observable from a channel.
   */
  channel$(name: string): Observable<{ type: string; payload: unknown }> {
    return new Observable<{ type: string; payload: unknown }>((subscriber) => {
      const channel = this.client.channel(name);
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
