/**
 * ChatSessionService — Angular service wrapping ChatSession with signals.
 *
 * Mirrors React's `useChat` hook but uses Angular `signal()` + `computed()`.
 * Each instance owns a ChatSession and syncs its state into signals on every
 * state change.
 *
 * @module @agentick/angular/chat-session
 */

import {
  Injectable,
  InjectionToken,
  type OnDestroy,
  computed,
  signal,
  inject,
} from "@angular/core";
import {
  createClient,
  ChatSession,
  type ChatSessionOptions,
  type ChatSessionState,
  type ChatMode,
  type ChatMessage,
  type ToolConfirmationState,
  type SteeringMode,
  type Attachment,
  type AttachmentInput,
  type ToolConfirmationResponse,
  type Message,
  type ClientExecutionHandle,
} from "@agentick/client";
import type { AgentickConfig } from "./types.js";
import { TENTICKLE_CONFIG } from "./agentick.service.js";

/**
 * Injection token for ChatSession options.
 *
 * Provide at component level to configure session behavior
 * (renderMode, confirmationPolicy, sessionId, etc).
 */
export const CHAT_SESSION_OPTIONS = new InjectionToken<ChatSessionOptions>("CHAT_SESSION_OPTIONS");

/**
 * Provides ChatSessionService with optional configuration at component level.
 *
 * @example
 * ```typescript
 * @Component({
 *   providers: [
 *     provideAgentick({ baseUrl: '/api/v2' }),
 *     provideChatSession({ renderMode: 'streaming' }),
 *   ],
 * })
 * export class MyChatComponent {
 *   chat = inject(ChatSessionService);
 * }
 * ```
 */
export function provideChatSession(options: ChatSessionOptions = {}) {
  return [{ provide: CHAT_SESSION_OPTIONS, useValue: options }, ChatSessionService];
}

/**
 * Angular service wrapping `ChatSession` with signals.
 *
 * Exposes all ChatSessionState fields as Angular signals and all
 * ChatSession actions as methods. Automatically syncs on every
 * state change and cleans up on destroy.
 *
 * @example
 * ```typescript
 * @Component({
 *   providers: [
 *     provideAgentick({ baseUrl: '/api/v2', token: myJwt }),
 *     provideChatSession({ renderMode: 'streaming' }),
 *   ],
 *   template: `
 *     @for (msg of chat.messages(); track msg.id) {
 *       <div>{{ msg.role }}: {{ msg.content }}</div>
 *     }
 *     <input #input />
 *     <button (click)="chat.submit(input.value); input.value = ''">Send</button>
 *   `,
 * })
 * export class ChatComponent {
 *   chat = inject(ChatSessionService);
 * }
 * ```
 */
@Injectable()
export class ChatSessionService implements OnDestroy {
  private readonly _chatSession: ChatSession;
  private readonly _unsubscribe: () => void;

  // ══════════════════════════════════════════════════════════════════════════
  // Signals — synced from ChatSessionState
  // ══════════════════════════════════════════════════════════════════════════

  readonly messages = signal<readonly ChatMessage[]>([]);
  readonly chatMode = signal<ChatMode>("idle");
  readonly toolConfirmation = signal<ToolConfirmationState | null>(null);
  readonly lastSubmitted = signal<string | null>(null);
  readonly queued = signal<readonly Message[]>([]);
  readonly isExecuting = signal<boolean>(false);
  readonly mode = signal<SteeringMode>("steer");
  readonly error = signal<{ message: string; name: string } | null>(null);
  readonly attachments = signal<readonly Attachment[]>([]);

  // ══════════════════════════════════════════════════════════════════════════
  // Computed signals
  // ══════════════════════════════════════════════════════════════════════════

  readonly isIdle = computed(() => this.chatMode() === "idle");
  readonly isStreaming = computed(() => this.chatMode() === "streaming");
  readonly isConfirmingTool = computed(() => this.chatMode() === "confirming_tool");

  // ══════════════════════════════════════════════════════════════════════════
  // Constructor
  // ══════════════════════════════════════════════════════════════════════════

  constructor() {
    const config = inject(TENTICKLE_CONFIG);
    const options = inject(CHAT_SESSION_OPTIONS, { optional: true }) ?? {};

    const client = createClient(config);
    this._chatSession = new ChatSession(client, options);
    this._unsubscribe = this._chatSession.onStateChange(() => this._sync());
    this._sync();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Actions — delegate to ChatSession
  // ══════════════════════════════════════════════════════════════════════════

  submit(text: string): void {
    this._chatSession.submit(text);
  }

  steer(text: string): void {
    this._chatSession.steer(text);
  }

  queue(text: string): void {
    this._chatSession.queue(text);
  }

  interrupt(text: string): Promise<ClientExecutionHandle> {
    return this._chatSession.interrupt(text);
  }

  abort(reason?: string): void {
    this._chatSession.abort(reason);
  }

  flush(): void {
    this._chatSession.flush();
  }

  removeQueued(index: number): void {
    this._chatSession.removeQueued(index);
  }

  clearQueued(): void {
    this._chatSession.clearQueued();
  }

  setMode(mode: SteeringMode): void {
    this._chatSession.setMode(mode);
  }

  respondToConfirmation(response: ToolConfirmationResponse): void {
    this._chatSession.respondToConfirmation(response);
  }

  /**
   * Prepend older messages (e.g. fetched from DB on scroll-back).
   * Messages appear at the start of the list.
   */
  prependMessages(messages: readonly ChatMessage[]): void {
    this._chatSession.prependMessages(messages);
  }

  /**
   * Append messages (e.g. initial load from DB, or external sources).
   * Messages appear at the end of the list.
   */
  appendMessages(messages: readonly ChatMessage[]): void {
    this._chatSession.appendMessages(messages);
  }

  clearMessages(): void {
    this._chatSession.clearMessages();
  }

  addAttachment(input: AttachmentInput): Attachment {
    return this._chatSession.attachments.add(input);
  }

  removeAttachment(id: string): void {
    this._chatSession.attachments.remove(id);
  }

  clearAttachments(): void {
    this._chatSession.attachments.clear();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  ngOnDestroy(): void {
    this._unsubscribe();
    this._chatSession.destroy();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private
  // ══════════════════════════════════════════════════════════════════════════

  private _sync(): void {
    const s = this._chatSession.state;
    this.messages.set(s.messages);
    this.chatMode.set(s.chatMode);
    this.toolConfirmation.set(s.toolConfirmation);
    this.lastSubmitted.set(s.lastSubmitted);
    this.queued.set(s.queued);
    this.isExecuting.set(s.isExecuting);
    this.mode.set(s.mode);
    this.error.set(s.error);
    this.attachments.set(s.attachments);
  }
}
