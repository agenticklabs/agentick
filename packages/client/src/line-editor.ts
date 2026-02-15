/**
 * LineEditor — framework-agnostic readline-quality line editor.
 *
 * Manages buffer, cursor, kill ring, history, keybindings, and completion.
 * Accepts normalized keystroke strings — each UI layer provides
 * its own normalizer (e.g., Ink's Key → "ctrl+a").
 *
 * Follows the same snapshot + onStateChange pattern as MessageSteering
 * and ChatSession for easy integration with useSyncExternalStore.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface LineEditorOptions {
  onSubmit: (value: string) => void;
  bindings?: Record<string, string>;
}

export interface LineEditorSnapshot {
  readonly value: string;
  readonly cursor: number;
  readonly completion: CompletionState | null;
  readonly completedRanges: readonly CompletedRange[];
}

export interface EditorUpdate {
  value?: string;
  cursor?: number;
  killed?: string;
}

export interface CompletionContext {
  value: string;
  cursor: number;
}

export interface CompletionMatch {
  from: number;
  query: string;
}

export interface CompletionSource {
  id: string;
  match(ctx: CompletionContext): CompletionMatch | null;
  resolve(ctx: CompletionContext & CompletionMatch): CompletionItem[] | Promise<CompletionItem[]>;
  debounce?: number;
}

export interface CompletionItem {
  label: string;
  value: string;
  description?: string;
  /** When true, accepting this item re-probes the same source for follow-up completions (e.g. directory drilling). */
  continues?: boolean;
}

export interface CompletionState {
  readonly items: readonly CompletionItem[];
  readonly selectedIndex: number;
  readonly query: string;
  readonly loading: boolean;
  readonly sourceId: string;
  readonly from: number;
}

export interface CompletedRange {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly sourceId: string;
}

// ── Word boundaries ─────────────────────────────────────────────────────────

export function findWordBoundaryForward(value: string, cursor: number): number {
  let i = cursor;
  while (i < value.length && !/\w/.test(value[i]!)) i++;
  while (i < value.length && /\w/.test(value[i]!)) i++;
  return i;
}

export function findWordBoundaryBackward(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !/\w/.test(value[i - 1]!)) i--;
  while (i > 0 && /\w/.test(value[i - 1]!)) i--;
  return i;
}

// ── Actions (pure functions of editor state) ────────────────────────────────

export const actions: Record<
  string,
  (state: LineEditorSnapshot, killRing: string[]) => EditorUpdate
> = {
  lineStart: () => ({ cursor: 0 }),
  lineEnd: (s) => ({ cursor: s.value.length }),
  charForward: (s) => ({ cursor: Math.min(s.cursor + 1, s.value.length) }),
  charBackward: (s) => ({ cursor: Math.max(s.cursor - 1, 0) }),
  wordForward: (s) => ({ cursor: findWordBoundaryForward(s.value, s.cursor) }),
  wordBackward: (s) => ({ cursor: findWordBoundaryBackward(s.value, s.cursor) }),

  deleteForward: (s) => {
    if (s.cursor >= s.value.length) return {};
    return {
      value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1),
    };
  },

  deleteBackward: (s) => {
    if (s.cursor === 0) return {};
    return {
      value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor),
      cursor: s.cursor - 1,
    };
  },

  killToEnd: (s) => {
    if (s.cursor >= s.value.length) return {};
    const killed = s.value.slice(s.cursor);
    return { value: s.value.slice(0, s.cursor), killed };
  },

  killToStart: (s) => {
    if (s.cursor === 0) return {};
    const killed = s.value.slice(0, s.cursor);
    return { value: s.value.slice(s.cursor), cursor: 0, killed };
  },

  killWordBackward: (s) => {
    if (s.cursor === 0) return {};
    const boundary = findWordBoundaryBackward(s.value, s.cursor);
    const killed = s.value.slice(boundary, s.cursor);
    return {
      value: s.value.slice(0, boundary) + s.value.slice(s.cursor),
      cursor: boundary,
      killed,
    };
  },

  killWordForward: (s) => {
    if (s.cursor >= s.value.length) return {};
    const boundary = findWordBoundaryForward(s.value, s.cursor);
    const killed = s.value.slice(s.cursor, boundary);
    return {
      value: s.value.slice(0, s.cursor) + s.value.slice(boundary),
      killed,
    };
  },

  yank: (s, killRing) => {
    if (killRing.length === 0) return {};
    const text = killRing[killRing.length - 1]!;
    return {
      value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor),
      cursor: s.cursor + text.length,
    };
  },

  transpose: (s) => {
    if (s.value.length < 2) return {};
    if (s.cursor === 0) return {};
    let i: number;
    let j: number;
    if (s.cursor >= s.value.length) {
      i = s.cursor - 2;
      j = s.cursor - 1;
    } else {
      i = s.cursor - 1;
      j = s.cursor;
    }
    const chars = [...s.value];
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
    return {
      value: chars.join(""),
      cursor: j + 1,
    };
  },
};

// ── Default bindings ────────────────────────────────────────────────────────

export const DEFAULT_BINDINGS: Record<string, string> = {
  "ctrl+a": "lineStart",
  "ctrl+e": "lineEnd",
  "ctrl+f": "charForward",
  "ctrl+b": "charBackward",
  "meta+f": "wordForward",
  "meta+b": "wordBackward",
  "meta+right": "wordForward",
  "meta+left": "wordBackward",
  left: "charBackward",
  right: "charForward",
  "ctrl+d": "deleteForward",
  "ctrl+h": "deleteBackward",
  backspace: "deleteBackward",
  delete: "deleteBackward",
  "ctrl+k": "killToEnd",
  "ctrl+u": "killToStart",
  "ctrl+w": "killWordBackward",
  "meta+d": "killWordForward",
  "ctrl+y": "yank",
  "ctrl+t": "transpose",
};

// ── LineEditor class ────────────────────────────────────────────────────────

export const EMPTY_SNAPSHOT: LineEditorSnapshot = {
  value: "",
  cursor: 0,
  completion: null,
  completedRanges: [],
};

const MAX_KILL_RING = 60;

export class LineEditor {
  private _value = "";
  private _cursor = 0;
  private _killRing: string[] = [];
  private _history: string[] = [];
  private _historyIndex = -1;
  private _savedInput = "";

  private readonly _bindings: Record<string, string>;
  private readonly _onSubmit: (value: string) => void;

  private _snapshot: LineEditorSnapshot = EMPTY_SNAPSHOT;
  private _listeners = new Set<() => void>();

  // Completion state
  private _sources: CompletionSource[] = [];
  private _from = -1;
  private _activeSource: CompletionSource | null = null;
  private _resolveId = 0;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _completionState: CompletionState | null = null;
  private _completedRanges: CompletedRange[] = [];

  constructor(options: LineEditorOptions) {
    this._onSubmit = options.onSubmit;
    this._bindings = options.bindings ?? DEFAULT_BINDINGS;
  }

  get state(): LineEditorSnapshot {
    return this._snapshot;
  }

  registerCompletion(source: CompletionSource): () => void {
    this._sources.push(source);
    return () => {
      const idx = this._sources.indexOf(source);
      if (idx !== -1) this._sources.splice(idx, 1);
    };
  }

  /**
   * Process a keystroke. `keystroke` is a normalized string like "ctrl+a",
   * "return", "up", "tab", etc., or `null` for regular text input.
   * `text` is the raw input string (used for character insertion).
   */
  handleInput(keystroke: string | null, text: string): void {
    const val = this._value;
    const cur = Math.min(this._cursor, val.length);

    // ── Completion interception ──────────────────────────────────────────
    if (this._activeSource) {
      if (keystroke === "return" || keystroke === "tab") {
        this._acceptCompletion();
        return;
      }
      if (keystroke === "escape") {
        this._dismissCompletion();
        return;
      }
      if (keystroke === "up") {
        this._navigateCompletion(-1);
        return;
      }
      if (keystroke === "down") {
        this._navigateCompletion(1);
        return;
      }
      // Fall through to normal handling for all other keystrokes
    }

    // Enter → submit
    if (keystroke === "return") {
      const trimmed = val.trim();
      if (trimmed) {
        this._history.push(val);
        this._historyIndex = -1;
        this._savedInput = "";
        this._onSubmit(trimmed);
        this._update("", 0);
      }
      return;
    }

    // History navigation
    if (keystroke === "up") {
      const history = this._history;
      if (history.length === 0) return;
      if (this._historyIndex === -1) {
        this._savedInput = val;
        this._historyIndex = history.length - 1;
      } else if (this._historyIndex > 0) {
        this._historyIndex--;
      } else {
        return; // already at oldest
      }
      const entry = history[this._historyIndex]!;
      this._update(entry, entry.length);
      return;
    }

    if (keystroke === "down") {
      if (this._historyIndex === -1) return;
      const history = this._history;
      if (this._historyIndex < history.length - 1) {
        this._historyIndex++;
        const entry = history[this._historyIndex]!;
        this._update(entry, entry.length);
      } else {
        this._historyIndex = -1;
        const saved = this._savedInput;
        this._update(saved, saved.length);
      }
      return;
    }

    // Tab — no-op when not completing
    if (keystroke === "tab") return;

    // Escape — no-op when not completing
    if (keystroke === "escape") return;

    // Check bindings
    if (keystroke) {
      const actionName = this._bindings[keystroke];
      if (actionName) {
        const action = actions[actionName];
        if (action) {
          const snap: LineEditorSnapshot = {
            value: val,
            cursor: cur,
            completion: this._completionState,
            completedRanges: this._completedRanges,
          };
          const result = action(snap, this._killRing);
          const newValue = result.value ?? val;
          const newCursor = result.cursor ?? cur;
          if (result.killed) {
            this._killRing.push(result.killed);
            if (this._killRing.length > MAX_KILL_RING) {
              this._killRing.splice(0, this._killRing.length - MAX_KILL_RING);
            }
          }
          this._applyEdit(newValue, newCursor);
          return;
        }
      }
    }

    // Regular character input
    if (!keystroke && text.length > 0) {
      const newValue = val.slice(0, cur) + text + val.slice(cur);
      this._applyEdit(newValue, cur + text.length);
    }
  }

  setValue(value: string): void {
    this._update(value, value.length);
  }

  clear(): void {
    this._update("", 0);
  }

  onStateChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  destroy(): void {
    this._dismissCompletionSilent();
    this._completedRanges = [];
    this._listeners.clear();
  }

  // ── Private: mutation primitives ────────────────────────────────────────

  private _notify(): void {
    this._snapshot = {
      value: this._value,
      cursor: this._cursor,
      completion: this._completionState,
      completedRanges: this._completedRanges,
    };
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        // Listeners should not throw
      }
    }
  }

  /** Mutate value/cursor and adjust completed ranges. No notification. */
  private _editValue(newValue: string, newCursor: number): void {
    const oldValue = this._value;
    this._value = newValue;
    this._cursor = newCursor;
    this._adjustRanges(oldValue, newValue);
  }

  /** Wholesale replacement — history nav, submit, setValue, clear. */
  private _update(value: string, cursor: number): void {
    if (this._activeSource) this._dismissCompletionSilent();
    this._completedRanges = [];
    this._value = value;
    this._cursor = cursor;
    this._notify();
  }

  /** Edit-aware mutation: adjust ranges, run completion state machine, notify. */
  private _applyEdit(newValue: string, newCursor: number): void {
    this._editValue(newValue, newCursor);

    const ctx: CompletionContext = { value: this._value, cursor: this._cursor };

    if (this._activeSource) {
      const match = this._activeSource.match(ctx);
      if (match) {
        this._from = match.from;
        this._resolve(this._activeSource, { ...ctx, ...match });
      } else {
        this._dismissCompletionSilent();
        this._probeAllSources(ctx);
      }
    } else {
      this._probeAllSources(ctx);
    }

    this._notify();
  }

  // ── Private: range tracking ────────────────────────────────────────────

  private _adjustRanges(oldValue: string, newValue: string): void {
    if (oldValue === newValue || this._completedRanges.length === 0) return;

    // Find the edit region by comparing common prefix and suffix
    let prefixLen = 0;
    const minLen = Math.min(oldValue.length, newValue.length);
    while (prefixLen < minLen && oldValue[prefixLen] === newValue[prefixLen]) {
      prefixLen++;
    }

    let suffixLen = 0;
    while (
      suffixLen < minLen - prefixLen &&
      oldValue[oldValue.length - 1 - suffixLen] === newValue[newValue.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    const editStart = prefixLen;
    const editEndOld = oldValue.length - suffixLen;
    const delta = newValue.length - oldValue.length;

    const kept: CompletedRange[] = [];
    for (const range of this._completedRanges) {
      // Range entirely before edit region — unchanged
      if (range.end <= editStart) {
        kept.push(range);
        continue;
      }
      // Range entirely after edit region — shift
      if (range.start >= editEndOld) {
        kept.push({
          start: range.start + delta,
          end: range.end + delta,
          value: range.value,
          sourceId: range.sourceId,
        });
        continue;
      }
      // Overlaps edit region — invalidate (drop it)
    }
    this._completedRanges = kept;
  }

  // ── Private: completion state machine ──────────────────────────────────

  /** Probe all registered sources. First match wins. */
  private _probeAllSources(ctx: CompletionContext): void {
    for (const source of this._sources) {
      const match = source.match(ctx);
      if (match) {
        this._activeSource = source;
        this._from = match.from;
        this._resolve(source, { ...ctx, ...match });
        return;
      }
    }
  }

  /**
   * Start or restart resolution.
   *
   * Inline path (no debounce): calls _resolveNow, _applyEdit handles notification.
   * Deferred path (debounce): sets loading, timer calls _resolveNow + _notify.
   */
  private _resolve(source: CompletionSource, ctx: CompletionContext & CompletionMatch): void {
    this._resolveId++;
    const id = this._resolveId;

    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (source.debounce && source.debounce > 0) {
      this._completionState = this._loadingState(source, ctx.query);
      this._debounceTimer = setTimeout(() => {
        this._resolveNow(source, id, ctx);
        this._notify();
      }, source.debounce);
    } else {
      this._resolveNow(source, id, ctx);
    }
  }

  /**
   * Execute resolution immediately. Mutates _completionState but does NOT
   * notify — caller is responsible. Async promise callbacks self-notify.
   */
  private _resolveNow(
    source: CompletionSource,
    id: number,
    ctx: CompletionContext & CompletionMatch,
  ): void {
    const result = source.resolve(ctx);
    if (result instanceof Promise) {
      this._completionState = this._loadingState(source, ctx.query);
      result.then(
        (items) => {
          if (this._resolveId !== id) return;
          this._completionState = {
            items,
            selectedIndex: 0,
            query: ctx.query,
            loading: false,
            sourceId: source.id,
            from: this._from,
          };
          this._notify();
        },
        () => {
          if (this._resolveId !== id) return;
          this._completionState = {
            items: [],
            selectedIndex: 0,
            query: ctx.query,
            loading: false,
            sourceId: source.id,
            from: this._from,
          };
          this._notify();
        },
      );
    } else {
      this._completionState = {
        items: result,
        selectedIndex: 0,
        query: ctx.query,
        loading: false,
        sourceId: source.id,
        from: this._from,
      };
    }
  }

  private _loadingState(source: CompletionSource, query: string): CompletionState {
    return {
      items: this._completionState?.items ?? [],
      selectedIndex: this._completionState?.selectedIndex ?? 0,
      query,
      loading: true,
      sourceId: source.id,
      from: this._from,
    };
  }

  private _acceptCompletion(): void {
    const state = this._completionState;
    const source = this._activeSource;
    if (!state || !source || state.items.length === 0) {
      this._dismissCompletion();
      return;
    }

    const item = state.items[state.selectedIndex];
    if (!item) {
      this._dismissCompletion();
      return;
    }

    const before = this._value.slice(0, this._from);
    const after = this._value.slice(this._cursor);
    const newValue = before + item.value + after;
    const newCursor = before.length + item.value.length;

    const range: CompletedRange = {
      start: this._from,
      end: newCursor,
      value: item.value,
      sourceId: source.id,
    };

    const acceptedSourceId = source.id;
    const continues = item.continues === true;
    this._dismissCompletionSilent();
    this._editValue(newValue, newCursor);
    this._completedRanges = [...this._completedRanges, range];

    // Probe sources for chaining (e.g. command → file picker, or directory drilling).
    // Skip the accepted source unless the item signals continuation (e.g. a directory).
    const ctx: CompletionContext = { value: this._value, cursor: this._cursor };
    for (const s of this._sources) {
      if (s.id === acceptedSourceId && !continues) continue;
      const m = s.match(ctx);
      if (m) {
        this._activeSource = s;
        this._from = m.from;
        this._resolve(s, { ...ctx, ...m });
        break;
      }
    }
    this._notify();
  }

  private _navigateCompletion(delta: number): void {
    const state = this._completionState;
    if (!state || state.items.length === 0) return;

    const len = state.items.length;
    const next = (((state.selectedIndex + delta) % len) + len) % len;
    this._completionState = { ...state, selectedIndex: next };
    this._notify();
  }

  private _dismissCompletion(): void {
    this._dismissCompletionSilent();
    this._notify();
  }

  private _dismissCompletionSilent(): void {
    this._activeSource = null;
    this._from = -1;
    this._completionState = null;
    this._resolveId++;
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }
}
