/**
 * Entry Context
 *
 * The primitive notification bus for timeline entries. Components register
 * `useOnEntry` handlers to react to any timeline write — message
 * commits, events from `session.observe()`, future kinds — through one
 * uniform stream.
 *
 * Architecture:
 * - The React tree stays mounted across ticks (persistent)
 * - The session calls `compiler.notifyOnEntry(entry)` whenever a timeline
 *   entry is committed — from `session.append()`, from `session.observe()`,
 *   and from the tick-execution path that commits user/assistant/tool
 *   messages.
 * - Components register handlers via `useOnEntry(filter, handler)`. The
 *   filter (kind/role/type) selects which entries fire the handler.
 *
 * Relationship to MessageStore (in `message-context.ts`):
 * - `EntryStore` is a NEW handler bus that supersedes MessageStore's handler
 *   responsibilities. MessageStore today bundles two concerns: (a) handler
 *   dispatch for queued messages, and (b) the queue itself plus drain
 *   semantics. EntryStore takes over (a) for *committed* entries — which
 *   is the more meaningful semantic for most consumers ("this is now part
 *   of the conversation," not "the host is about to send this").
 * - MessageStore still exists for (b) — the pending-queue concern that's
 *   message-specific and doesn't generalize to other kinds (events don't
 *   queue; they commit immediately via `append`).
 * - `useOnMessage` retains its current "fires when a message is queued"
 *   semantic for now to avoid behavior change. A future cleanup will
 *   either collapse it into `useOnEntry({ kind: "message" }, ...)` with
 *   commit-time semantics, or split into `useOnQueuedMessage` (pre-commit)
 *   and `useOnMessage` (delegating to entry bus). See TODO in
 *   `message-context.ts`.
 *
 * @module @agentick/core/hooks/entry-context
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import type { COM } from "../com/object-model.js";
import type { COMTimelineEntry } from "../com/types.js";
import type { TickState } from "../component/component.js";
import type { TimelineEntry, Message } from "@agentick/shared";

const h = React.createElement;

// ============================================================
// Types
// ============================================================

/**
 * Filter for `useOnEntry`. All fields are optional and AND together —
 * an entry must match every specified field to fire the handler.
 *
 * - `kind` — TimelineEntry kind. Today always `"message"`. Reserved
 *   for future kinds (events as their own kind, etc.).
 * - `role` — Narrows within `kind: "message"`. One of `"user" |
 *   "assistant" | "system" | "tool" | "event"`.
 * - `type` — For event-role messages, narrows by `eventType`.
 */
export interface EntryFilter {
  kind?: TimelineEntry["kind"];
  role?: Message["role"];
  type?: string;
}

/**
 * Handler signature for `useOnEntry`. Receives the committed timeline
 * entry along with COM and TickState refs at the time of commit.
 */
export type EntryHandler = (
  entry: COMTimelineEntry,
  ctx: COM,
  state: TickState,
) => void | Promise<void>;

// ============================================================
// Entry Store (per-session)
// ============================================================

export interface EntryStore {
  /** Handler functions registered via useOnEntry */
  handlers: Set<EntryHandler>;

  /** Last received entry (for useLastEntry, future) */
  lastEntry: COMTimelineEntry | null;

  /** Subscribers for state changes */
  subscribers: Set<() => void>;

  /** Current COM reference (set by compiler) */
  ctx: COM | null;

  /** Current TickState reference (set by compiler) */
  tickState: TickState | null;
}

export function createEntryStore(): EntryStore {
  return {
    handlers: new Set(),
    lastEntry: null,
    subscribers: new Set(),
    ctx: null,
    tickState: null,
  };
}

/**
 * Run an entry through the store's handlers. Called by the compiler's
 * `notifyOnEntry`.
 */
export async function dispatchEntry(
  store: EntryStore,
  entry: COMTimelineEntry,
  ctx: COM,
  tickState: TickState,
): Promise<void> {
  store.ctx = ctx;
  store.tickState = tickState;
  store.lastEntry = entry;
  for (const handler of store.handlers) {
    await handler(entry, ctx, tickState);
  }
}

// ============================================================
// Filter helpers
// ============================================================

/** True if the entry passes the filter. */
export function matchesEntryFilter(entry: COMTimelineEntry, filter: EntryFilter): boolean {
  if (filter.kind && entry.kind !== filter.kind) return false;
  if (filter.role && entry.message?.role !== filter.role) return false;
  if (filter.type) {
    const eventType = (entry.message as any)?.eventType;
    if (eventType !== filter.type) return false;
  }
  return true;
}

// ============================================================
// React Context
// ============================================================

export interface EntryContextValue {
  /** Register an entry handler. Returns an unsubscribe function. */
  addEntryHandler: (handler: EntryHandler) => () => void;

  /** Last received entry */
  lastEntry: COMTimelineEntry | null;
}

const EntryContext = createContext<EntryContextValue | null>(null);

/**
 * Provider for entry context. Wraps the component tree alongside
 * MessageProvider in the compiler.
 */
export function EntryProvider({
  store,
  children,
}: {
  store: EntryStore;
  children?: ReactNode;
}): React.ReactElement {
  const addEntryHandler = useCallback(
    (handler: EntryHandler) => {
      store.handlers.add(handler);
      return () => {
        store.handlers.delete(handler);
      };
    },
    [store],
  );

  const value: EntryContextValue = {
    addEntryHandler,
    lastEntry: store.lastEntry,
  };

  return h(EntryContext.Provider, { value }, children);
}

// ============================================================
// Hooks
// ============================================================

/**
 * Register a handler for newly-committed timeline entries.
 *
 * Fires AFTER an entry is committed to the timeline — from
 * `session.append()`, `session.observe()`, the tick-execution commit
 * path (user/assistant/tool messages), or any future timeline write.
 *
 * This is the primitive timeline notification hook. `useOnMessage` and
 * `useOnEvent` are sugar over it.
 *
 * @example All entries
 * ```tsx
 * useOnEntry((entry, ctx, state) => {
 *   console.log("committed:", entry.kind, entry.message?.role);
 * });
 * ```
 *
 * @example Only events of a specific type
 * ```tsx
 * useOnEntry({ kind: "message", role: "event", type: "file_opened" }, (entry) => {
 *   const path = (entry.message as any).content?.[0]?.text;
 *   invalidateCache(path);
 * });
 * ```
 */
export function useOnEntry(handler: EntryHandler): void;
export function useOnEntry(filter: EntryFilter, handler: EntryHandler): void;
export function useOnEntry(
  filterOrHandler: EntryFilter | EntryHandler,
  maybeHandler?: EntryHandler,
): void {
  const ctx = useContext(EntryContext);
  const filter: EntryFilter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
  const handler: EntryHandler =
    typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler!;

  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    if (!ctx) return;
    const wrapped: EntryHandler = (entry, com, state) => {
      if (!matchesEntryFilter(entry, filterRef.current)) return;
      return handlerRef.current(entry, com, state);
    };
    return ctx.addEntryHandler(wrapped);
  }, [ctx]);
}

/**
 * Sugar over {@link useOnEntry} for event-role messages.
 *
 * @example
 * ```tsx
 * useOnEvent("file_opened", (entry, ctx) => { ... });
 * useOnEvent((entry) => { ... }); // any event
 * ```
 */
export function useOnEvent(handler: EntryHandler): void;
export function useOnEvent(type: string, handler: EntryHandler): void;
export function useOnEvent(
  typeOrHandler: string | EntryHandler,
  maybeHandler?: EntryHandler,
): void {
  if (typeof typeOrHandler === "function") {
    useOnEntry({ kind: "message", role: "event" }, typeOrHandler);
  } else {
    useOnEntry({ kind: "message", role: "event", type: typeOrHandler }, maybeHandler!);
  }
}
