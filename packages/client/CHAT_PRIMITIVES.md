# Chat Primitives — Design Document

## Problem

ChatSession bundles five concerns into one class:

1. Message accumulation from timeline events
2. Tool duration tracking
3. Tool confirmation lifecycle
4. Optimistic UI state (lastSubmitted)
5. Derived chatMode

This works for the common case but is not composable. A user building a
VS Code extension might want tool confirmations without message
accumulation. A dashboard might want tool durations without steering.
A custom chat UI might need four mode states instead of three.

The framework needs these as independent, composable primitives with
ChatSession as a convenience wrapper on top.

## Design Principles

1. **Each primitive works standalone.** No mandatory dependencies between
   them. Each subscribes to its own events and manages its own lifecycle.
2. **Each primitive is externally drivable.** When composed, a parent can
   call `processEvent()` instead of letting the primitive self-subscribe.
   This eliminates duplicate event subscriptions.
3. **Extension via functions, not subclasses.** Transform functions and
   policy functions are the customization points.
4. **Use existing framework types.** `TimelineEntry` from `@agentick/shared`,
   typed `StreamEvent` discriminated union, `ToolConfirmationRequest/Response`.
5. **Progressive disclosure.** Level 0 users call `useChat()`. Level 2
   users compose individual hooks. Level 3 users use raw `useEvents()`.

## Architecture

```
Standalone primitives (each usable independently):

  MessageLog          — execution_end → ChatMessage[]
  ToolConfirmations   — tool confirmations → pending state + respond
  MessageSteering     — (existing) send/queue/steer/interrupt

Composed convenience:

  ChatSession         — single event subscription, drives all three,
                         computes chatMode + lastSubmitted

React hooks:

  useMessages()              ← MessageLog
  useToolConfirmations()     ← ToolConfirmations
  useMessageSteering()       ← MessageSteering (existing)
  useChat()                  ← ChatSession
```

## Primitive 1: MessageLog

Accumulates messages from execution_end events. Tracks tool durations
internally (they're metadata on messages, never used without them).

### Types

```typescript
import type { TimelineEntry } from "@agentick/shared";
// Use the REAL TimelineEntry from shared — kind: "message" (required),
// message: Message (required). Not the weak { kind?: string } we had.

/**
 * Context passed to the transform function.
 * Contains accumulated metadata from the current execution.
 */
interface MessageTransformContext {
  /** Tool call durations accumulated during this execution. */
  toolDurations: ReadonlyMap<string, number>;
}

/**
 * Converts timeline entries into display messages.
 * The default implementation is `timelineToMessages` from chat-transforms.
 * Override to customize message extraction (include tool messages,
 * add custom metadata, change filtering, etc).
 */
type MessageTransform = (
  entries: TimelineEntry[],
  context: MessageTransformContext,
) => ChatMessage[];

interface MessageLogOptions {
  sessionId?: string;
  /** Pre-loaded messages (e.g. from session history). Sets initial messageCount for dedup. */
  initialMessages?: ChatMessage[];
  /** Custom transform. Default: timelineToMessages. */
  transform?: MessageTransform;
  /**
   * When true (default), subscribes to session events automatically.
   * When false, caller must call processEvent() manually.
   */
  subscribe?: boolean;
}

interface MessageLogState {
  readonly messages: readonly ChatMessage[];
}
```

### Class

```typescript
class MessageLog {
  private _messages: ChatMessage[];
  private _messageCount: number;
  private _toolTimers = new Map<string, number>();
  private _toolDurations = new Map<string, number>();
  private readonly _transform: MessageTransform;

  // Snapshot + listener (standard pattern)
  private _snapshot: MessageLogState;
  private _listeners = new Set<() => void>();
  private _unsubscribe: (() => void) | null = null;

  constructor(client: AgentickClient, options: MessageLogOptions = {}) {
    this._messages = options.initialMessages ? [...options.initialMessages] : [];
    this._messageCount = this._messages.length;
    this._transform = options.transform ?? defaultTransform;
    this._snapshot = this._createSnapshot();

    if (options.subscribe !== false && options.sessionId) {
      const accessor = client.session(options.sessionId);
      this._unsubscribe = accessor.onEvent((e) => this.processEvent(e));
    }
  }

  get state(): MessageLogState {
    return this._snapshot;
  }
  get messages(): readonly ChatMessage[] {
    return this._snapshot.messages;
  }

  /**
   * Process a stream event. Called automatically when self-subscribing,
   * or manually by a parent controller (ChatSession).
   */
  processEvent(event: StreamEvent): void {
    if (event.type === "tool_call_start") {
      const e = event as ToolCallStartEvent;
      this._toolTimers.set(e.callId, Date.now());
    }

    if (event.type === "tool_result") {
      const e = event as ToolResultEvent;
      const start = this._toolTimers.get(e.callId);
      if (start) {
        this._toolDurations.set(e.callId, Date.now() - start);
        this._toolTimers.delete(e.callId);
      }
    }

    if (event.type === "execution_end") {
      this._processExecutionEnd(event as ExecutionEndEvent);
      this._toolTimers.clear();
      this._notify();
    }
  }

  clear(): void {
    this._messages = [];
    this._messageCount = 0;
    this._toolTimers.clear();
    this._toolDurations.clear();
    this._notify();
  }

  onStateChange(listener: () => void): () => void {
    /* standard */
  }
  destroy(): void {
    this._unsubscribe?.();
    this._listeners.clear();
  }

  private _processExecutionEnd(event: ExecutionEndEvent): void {
    const context: MessageTransformContext = {
      toolDurations: this._toolDurations,
    };

    // Prefer delta (new entries only)
    const delta = event.newTimelineEntries as TimelineEntry[] | undefined;
    if (delta && delta.length > 0) {
      const newMsgs = this._transform(delta, context);
      if (newMsgs.length > 0) {
        this._messages = [...this._messages, ...newMsgs];
        this._messageCount += newMsgs.length;
      }
      return;
    }

    // Fallback: full timeline with messageCount dedup
    const output = event.output as { timeline?: TimelineEntry[] } | undefined;
    const timeline = output?.timeline;
    if (Array.isArray(timeline)) {
      const all = this._transform(timeline, context);
      const newMsgs = all.slice(this._messageCount);
      if (newMsgs.length > 0) {
        this._messages = [...this._messages, ...newMsgs];
        this._messageCount += newMsgs.length;
      }
    }
  }
}
```

### Why tool durations live inside MessageLog

Durations are metadata attached to messages. They are never consumed
independently of messages. A separate ToolDurations class would be 20
lines of logic wrapped in 50 lines of boilerplate, with zero standalone
use cases. If someone needs raw duration data, they can write 10 lines
with `useEvents()`. Not everything needs to be a class.

The transform function receives durations via `MessageTransformContext`,
so custom transforms have full access to them.

### Default transform

```typescript
function defaultTransform(
  entries: TimelineEntry[],
  context: MessageTransformContext,
): ChatMessage[] {
  return timelineToMessages(entries, context.toolDurations);
}
```

`timelineToMessages` already exists in `chat-transforms.ts`. The default
transform is a one-liner that passes through to it. The function signature
changes slightly to accept `MessageTransformContext` instead of a raw Map.

## Primitive 2: ToolConfirmations

Manages the tool confirmation lifecycle. Receives confirmation requests,
holds pending state, provides a respond function.

### Types

```typescript
/**
 * Policy for handling incoming tool confirmations.
 * Called before showing to the user. Return value determines behavior:
 * - "prompt": Show to user (default for all tools)
 * - "approve": Auto-approve without user interaction
 * - "deny": Auto-deny with optional reason
 */
type ConfirmationDecision =
  | { action: "prompt" }
  | { action: "approve" }
  | { action: "deny"; reason?: string };

type ConfirmationPolicy = (request: ToolConfirmationRequest) => ConfirmationDecision;

interface ToolConfirmationsOptions {
  sessionId?: string;
  /** Policy for auto-approving/denying tools. Default: always prompt. */
  policy?: ConfirmationPolicy;
  /** When false, caller must call handleConfirmation() manually. */
  subscribe?: boolean;
}

interface ToolConfirmationsState {
  /** The pending confirmation, or null if none. */
  readonly pending: ToolConfirmationState | null;
}
```

### Class

```typescript
class ToolConfirmations {
  private _pending: ToolConfirmationState | null = null;
  private readonly _policy: ConfirmationPolicy;

  private _snapshot: ToolConfirmationsState;
  private _listeners = new Set<() => void>();
  private _unsubscribe: (() => void) | null = null;

  constructor(client: AgentickClient, options: ToolConfirmationsOptions = {}) {
    this._policy = options.policy ?? (() => ({ action: "prompt" }));
    this._snapshot = this._createSnapshot();

    if (options.subscribe !== false && options.sessionId) {
      const accessor = client.session(options.sessionId);
      this._unsubscribe = accessor.onToolConfirmation((request, respond) =>
        this.handleConfirmation(request, respond),
      );
    }
  }

  get state(): ToolConfirmationsState {
    return this._snapshot;
  }
  get pending(): ToolConfirmationState | null {
    return this._snapshot.pending;
  }

  /**
   * Handle an incoming tool confirmation. Called automatically when
   * self-subscribing, or manually by a parent controller.
   */
  handleConfirmation(
    request: ToolConfirmationRequest,
    respond: (response: ToolConfirmationResponse) => void,
  ): void {
    const decision = this._policy(request);

    if (decision.action === "approve") {
      respond({ approved: true });
      return;
    }

    if (decision.action === "deny") {
      respond({ approved: false, reason: decision.reason });
      return;
    }

    // "prompt" — surface to consumer
    this._pending = { request, respond };
    this._notify();
  }

  respond(response: ToolConfirmationResponse): void {
    if (!this._pending) return;
    this._pending.respond(response);
    this._pending = null;
    this._notify();
  }

  onStateChange(listener: () => void): () => void {
    /* standard */
  }
  destroy(): void {
    this._unsubscribe?.();
    this._listeners.clear();
  }
}
```

### Why ConfirmationPolicy exists

The server-side `requiresConfirmation` on tools decides WHETHER a tool
needs confirmation. The client-side `ConfirmationPolicy` decides HOW
the client responds. They're complementary:

- Server: "This tool requires confirmation" (tool-level)
- Client: "Auto-approve read-only tools for this user" (user-level)

Use cases:

- A power user sets policy to auto-approve `read_file`, `glob`, `grep`
- A CI bot auto-approves everything
- A restricted environment auto-denies `shell` and `write_file`
- Default: always prompt (matches current behavior)

## Primitive 3: MessageSteering (changes)

MessageSteering already exists and works. Two changes:

### Change 1: Add `processEvent()` method

```typescript
class MessageSteering {
  // ... existing ...

  /**
   * Process a stream event for execution tracking.
   * Called automatically when self-subscribing (default),
   * or manually by a parent controller.
   */
  processEvent(event: StreamEvent): void {
    if (event.type === "execution_start") {
      this._isExecuting = true;
      this._notify();
    }
    if (event.type === "execution_end") {
      this._isExecuting = false;
      if (this._autoFlush) this._flushNext();
      this._notify();
    }
  }
}
```

The existing constructor already has this logic inline in the onEvent
callback. Extracting it to a public method is a pure refactor — the
constructor calls `processEvent()` instead of inlining the logic.

### Change 2: Add `subscribe` option

```typescript
interface MessageSteeringOptions {
  sessionId?: string;
  mode?: SteeringMode;
  flushMode?: FlushMode;
  autoFlush?: boolean;
  /** When false, caller must call processEvent() manually. Default: true. */
  subscribe?: boolean;
}
```

When `subscribe: false`, the constructor skips the `accessor.onEvent()`
subscription. The caller is responsible for feeding events via
`processEvent()`.

**Backwards compatible.** Default is `true`. Existing code is unaffected.
`useMessageSteering()` hook doesn't change at all.

## Composed: ChatSession (revised)

ChatSession composes all three primitives. It owns a single event
subscription and drives the primitives via their public methods.

### Types

```typescript
/**
 * Derives the chat mode from execution and confirmation state.
 * Default: idle/streaming/confirming_tool.
 * Override for custom modes (e.g. "error", "reconnecting").
 */
type ChatModeDeriver<T extends string = ChatMode> = (input: {
  isExecuting: boolean;
  hasPendingConfirmation: boolean;
}) => T;

interface ChatSessionOptions extends MessageSteeringOptions {
  /** Pre-loaded messages. Passed to MessageLog. */
  initialMessages?: ChatMessage[];
  /** Custom message transform. Passed to MessageLog. */
  transform?: MessageTransform;
  /** Auto-approve/deny policy. Passed to ToolConfirmations. */
  confirmationPolicy?: ConfirmationPolicy;
  /** Custom mode derivation. */
  deriveMode?: ChatModeDeriver;
  /** Raw event hook — called for every event before processing. */
  onEvent?: (event: StreamEvent) => void;
}

interface ChatSessionState {
  readonly messages: readonly ChatMessage[];
  readonly chatMode: ChatMode | string;
  readonly toolConfirmation: ToolConfirmationState | null;
  readonly lastSubmitted: string | null;
  readonly queued: readonly Message[];
  readonly isExecuting: boolean;
  readonly mode: SteeringMode;
}
```

### Class

```typescript
class ChatSession {
  private readonly _messageLog: MessageLog;
  private readonly _confirmations: ToolConfirmations;
  private readonly _steering: MessageSteering;
  private readonly _deriveMode: ChatModeDeriver;
  private readonly _onEvent?: (event: StreamEvent) => void;

  private _lastSubmitted: string | null = null;

  // Single subscription handles
  private _unsubscribeEvents: (() => void) | null = null;
  private _unsubscribeConfirmations: (() => void) | null = null;

  // Snapshot + listeners
  private _snapshot: ChatSessionState;
  private _listeners = new Set<() => void>();

  constructor(client: AgentickClient, options: ChatSessionOptions = {}) {
    this._deriveMode = options.deriveMode ?? defaultDeriveMode;
    this._onEvent = options.onEvent;

    // Create primitives in externally-driven mode (subscribe: false).
    // ChatSession owns the single event subscription.
    this._messageLog = new MessageLog(client, {
      sessionId: options.sessionId,
      initialMessages: options.initialMessages,
      transform: options.transform,
      subscribe: false,
    });

    this._confirmations = new ToolConfirmations(client, {
      sessionId: options.sessionId,
      policy: options.confirmationPolicy,
      subscribe: false,
    });

    this._steering = new MessageSteering(client, {
      ...options,
      subscribe: false,
    });

    this._snapshot = this._createSnapshot();

    // Single event subscription — fans out to all primitives
    if (options.sessionId) {
      const accessor = client.session(options.sessionId);

      this._unsubscribeEvents = accessor.onEvent((event) => {
        this._onEvent?.(event);
        this._steering.processEvent(event);
        this._messageLog.processEvent(event);

        // Clear lastSubmitted on execution_end
        if (event.type === "execution_end") {
          this._lastSubmitted = null;
        }

        this._notify();
      });

      this._unsubscribeConfirmations = accessor.onToolConfirmation((request, respond) => {
        this._confirmations.handleConfirmation(request, respond);
        this._notify();
      });
    }
  }

  // --- Public API (state) ---

  get state(): ChatSessionState {
    return this._snapshot;
  }
  get messages() {
    return this._snapshot.messages;
  }
  get chatMode() {
    return this._snapshot.chatMode;
  }
  get toolConfirmation() {
    return this._snapshot.toolConfirmation;
  }
  get lastSubmitted() {
    return this._snapshot.lastSubmitted;
  }
  get queued() {
    return this._snapshot.queued;
  }
  get isExecuting() {
    return this._snapshot.isExecuting;
  }
  get mode() {
    return this._snapshot.mode;
  }

  // --- Public API (actions) ---

  submit(text: string): void {
    this._lastSubmitted = text;
    this._steering.submit(text);
    this._notify();
  }

  steer(text: string): void {
    this._steering.steer(text);
    this._notify();
  }

  queue(text: string): void {
    this._steering.queue(text);
    this._notify();
  }

  interrupt(text: string) {
    return this._steering.interrupt(text);
  }

  flush(): void {
    this._steering.flush();
    this._notify();
  }

  removeQueued(index: number): void {
    this._steering.removeQueued(index);
    this._notify();
  }

  clearQueued(): void {
    this._steering.clearQueued();
    this._notify();
  }

  setMode(mode: SteeringMode): void {
    this._steering.setMode(mode);
    this._notify();
  }

  respondToConfirmation(response: ToolConfirmationResponse): void {
    this._confirmations.respond(response);
    this._notify();
  }

  clearMessages(): void {
    this._messageLog.clear();
    this._lastSubmitted = null;
    this._steering.clearQueued();
    this._notify();
  }

  // --- Subscription ---

  onStateChange(listener: () => void): () => void {
    /* standard */
  }

  destroy(): void {
    this._unsubscribeEvents?.();
    this._unsubscribeConfirmations?.();
    this._messageLog.destroy();
    this._confirmations.destroy();
    this._steering.destroy();
    this._listeners.clear();
  }

  // --- Private ---

  private _createSnapshot(): ChatSessionState {
    const steeringState = this._steering.state;
    const logState = this._messageLog.state;
    const confirmState = this._confirmations.state;

    return {
      messages: logState.messages,
      chatMode: this._deriveMode({
        isExecuting: steeringState.isExecuting,
        hasPendingConfirmation: confirmState.pending !== null,
      }),
      toolConfirmation: confirmState.pending,
      lastSubmitted: this._lastSubmitted,
      queued: steeringState.queued,
      isExecuting: steeringState.isExecuting,
      mode: steeringState.mode,
    };
  }
}
```

### What this fixes

1. **Single event subscription.** ChatSession subscribes once. No ordering
   dependency. No duplicate handlers. It calls `processEvent()` on each
   primitive in a deterministic order.

2. **Proper event types.** Uses `ToolCallStartEvent`, `ToolResultEvent`,
   `ExecutionEndEvent` from `@agentick/shared`. No `as any`.

3. **Shared TimelineEntry.** Uses `TimelineEntry` from `@agentick/shared`
   (required `kind: "message"`, required `message: Message`). Not the
   weak `{ kind?: string; message?: Message }`.

4. **chatMode is derived, not tracked.** Instead of setting chatMode in
   event handlers, it's computed from `isExecuting` + `hasPendingConfirmation`
   in `_createSnapshot()`. No stale state. No missed transitions.

5. **No dead code in types.** `ToolCallEntry.status` drops `"running"` —
   the transform only produces `"done"`. If streaming tool calls are
   needed later, the transform function is the extension point.

## React Hooks

### useMessages

```typescript
function useMessages(options: MessageLogOptions = {}): {
  messages: readonly ChatMessage[];
  clear: () => void;
};
```

Thin `useSyncExternalStore` wrapper over `MessageLog`. Same pattern
as `useMessageSteering`.

### useToolConfirmations

```typescript
function useToolConfirmations(options: ToolConfirmationsOptions = {}): {
  pending: ToolConfirmationState | null;
  respond: (response: ToolConfirmationResponse) => void;
};
```

Thin wrapper over `ToolConfirmations`.

### useChat (unchanged API)

```typescript
function useChat(options: ChatSessionOptions = {}): UseChatResult;
```

Wraps `ChatSession`. API is the same as current. New options
(`transform`, `confirmationPolicy`, `deriveMode`) are additive.

## Progressive Disclosure in Practice

### Level 0: Just works

```typescript
const { messages, submit, chatMode } = useChat({ sessionId });
```

### Level 1: Customize behavior

```typescript
const { messages, submit } = useChat({
  sessionId,
  // Auto-approve read-only tools
  confirmationPolicy: (req) =>
    ["read_file", "glob", "grep"].includes(req.name) ? { action: "approve" } : { action: "prompt" },
  // Custom modes
  deriveMode: ({ isExecuting, hasPendingConfirmation }) => {
    if (hasPendingConfirmation) return "confirming";
    if (isExecuting) return "thinking";
    return "ready";
  },
});
```

### Level 2: Compose individual primitives

```typescript
function CustomChat({ sessionId }) {
  // Mix and match primitives
  const { messages, clear } = useMessages({ sessionId });
  const { submit, queued } = useMessageSteering({ sessionId, mode: "queue" });
  const { pending, respond } = useToolConfirmations({
    sessionId,
    policy: autoApproveReads,
  });

  // Derive your own mode
  const mode = pending ? "confirm" : messages.length > 0 ? "active" : "empty";

  return <MyCustomUI messages={messages} mode={mode} />;
}
```

### Level 3: Raw events

```typescript
function FullyCustom({ sessionId }) {
  const { event } = useEvents({ sessionId });
  const [state, dispatch] = useReducer(myReducer, initialState);

  useEffect(() => {
    if (event) dispatch(event);
  }, [event]);

  return <Whatever state={state} />;
}
```

## Default chatMode derivation

```typescript
function defaultDeriveMode(input: {
  isExecuting: boolean;
  hasPendingConfirmation: boolean;
}): ChatMode {
  if (input.hasPendingConfirmation) return "confirming_tool";
  if (input.isExecuting) return "streaming";
  return "idle";
}
```

This is a pure function, not a method. It's exported for users who
want to extend it:

```typescript
import { defaultDeriveMode } from "@agentick/client";

const myDeriver = (input) => {
  const base = defaultDeriveMode(input);
  if (base === "idle" && hasError) return "error";
  return base;
};
```

## Notification strategy

ChatSession calls `_notify()` once per event, after all primitives
have processed. It does NOT subscribe to individual primitive
`onStateChange` callbacks. This gives exactly one snapshot + one
notification per event, regardless of how many primitives are
affected.

When used standalone, each primitive notifies independently. There's
no batching needed because each primitive only fires on events it
cares about.

## Changes to existing code

### MessageSteering (additive)

1. Add `processEvent(event: StreamEvent): void` — public method,
   extracted from the constructor's event handler.
2. Add `subscribe?: boolean` option — when false, skip self-subscription.
3. Constructor refactored to call `this.processEvent(event)` in its
   handler instead of inlining the logic.

These are backwards-compatible. Default behavior unchanged.

### chat-types.ts

1. Delete weak `TimelineEntry` type — use `@agentick/shared`'s.
2. Add `MessageTransform`, `MessageTransformContext` types.
3. Add `ConfirmationPolicy`, `ConfirmationDecision` types.
4. Add `ChatModeDeriver` type.
5. `ToolCallEntry.status` becomes just `"done"` (literal type).
6. `ChatSessionOptions` gains `transform`, `confirmationPolicy`,
   `deriveMode`, `onEvent` fields.

### chat-transforms.ts

1. `timelineToMessages` signature changes to accept
   `ReadonlyMap<string, number>` (already does) — but the function
   that ChatSession passes is now `MessageTransformContext.toolDurations`.
2. The default transform wraps `timelineToMessages` to match the
   `MessageTransform` signature.

### Testing mock

Already updated with `_emitToolConfirmation`. No further changes
needed.

## New files

| File                         | Package | Description               |
| ---------------------------- | ------- | ------------------------- |
| `message-log.ts`             | client  | MessageLog class          |
| `tool-confirmations.ts`      | client  | ToolConfirmations class   |
| `message-log.spec.ts`        | client  | MessageLog tests          |
| `tool-confirmations.spec.ts` | client  | ToolConfirmations tests   |
| `use-messages.ts`            | react   | useMessages hook          |
| `use-tool-confirmations.ts`  | react   | useToolConfirmations hook |

## Files modified

| File                     | Change                                        |
| ------------------------ | --------------------------------------------- |
| `message-steering.ts`    | Add processEvent(), subscribe option          |
| `chat-session.ts`        | Rewrite to compose primitives                 |
| `chat-types.ts`          | Add transform/policy types, fix TimelineEntry |
| `chat-transforms.ts`     | Add defaultTransform wrapper                  |
| `index.ts` (client)      | Export new primitives                         |
| `index.ts` (react)       | Export new hooks                              |
| `hooks/index.ts` (react) | Export new hooks                              |
| `testing.ts`             | No changes needed                             |

## Migration

The tentickle TUI migration is unaffected — `useChat()` API is the
same. The only visible change is new options available on `useChat()`.

The existing `chat-session.spec.ts` tests remain valid. New tests
are added for MessageLog and ToolConfirmations independently.

## What this does NOT include

- **Streaming text.** Already handled by `useStreamingText()` at
  the client level. Not a chat primitive.
- **Error state.** Stays in the UI component. Not every chat has
  the same error semantics.
- **Slash commands.** UI concern, not a chat primitive.
- **Message persistence / history loading.** Future work via
  `initialMessages` option.
- **Typing indicators / presence.** Different concern, different
  event source.

## Implementation order

1. Add `processEvent()` + `subscribe` to MessageSteering
2. Create MessageLog class + tests
3. Create ToolConfirmations class + tests
4. Rewrite ChatSession to compose primitives
5. Update chat-types.ts with new types
6. Create useMessages + useToolConfirmations hooks
7. Update exports
8. Run all tests
9. Build agentick + tentickle
