# LineEditor Completion System

Internal reference for developers and agents working with the LineEditor
completion engine. The system lives in `@agentick/client` (framework-agnostic
core) with UI integration in `@agentick/tui` and `@agentick/react`.

## Architecture

```
@agentick/client          LineEditor class, CompletionSource, state machine
  |
  +---> @agentick/react   useLineEditor hook (web/React wrapper)
  |
  +---> @agentick/tui     useLineEditor hook (Ink wrapper) + CompletionPicker
            |
            +---> consumer (registers sources, renders picker)
```

The core `LineEditor` owns all state: buffer, cursor, kill ring, history,
completion state machine, and completed ranges. Each UI layer provides a thin
hook that bridges the core into its rendering environment.

## CompletionSource

A completion source describes when and how to provide suggestions. The API
follows the CodeMirror 6 / TipTap mentions pattern: `match` decides if the
source is active, `resolve` produces items.

```typescript
interface CompletionContext {
  value: string; // Full buffer contents
  cursor: number; // Cursor position
}

interface CompletionMatch {
  from: number; // Replacement range start
  query: string; // Text extracted by the source for filtering
}

interface CompletionSource {
  id: string;
  match(ctx: CompletionContext): CompletionMatch | null;
  resolve(ctx: CompletionContext & CompletionMatch): CompletionItem[] | Promise<CompletionItem[]>;
  debounce?: number;
}

interface CompletionItem {
  label: string; // Display text in the picker
  value: string; // Inserted into the buffer on accept
  description?: string; // Secondary text (shown dimmed)
  continues?: boolean; // Re-probe same source after acceptance
}
```

### Fields

- **`id`** — Unique identifier. Used in `CompletedRange.sourceId` to track
  which source produced an accepted completion.

- **`match(ctx)`** — Called on every edit with the current buffer and cursor
  position. Returns a `CompletionMatch` to activate completion, or `null` to
  skip. Must be cheap — just text scanning, no I/O. The source owns all
  activation logic (position constraints, prefix checks, etc.).

- **`resolve(ctx)`** — Called with the full context (value, cursor, from,
  query) when `match` returns non-null. Returns items synchronously or as a
  Promise. Called on every keystroke while completing (with updated context).

- **`debounce`** — Milliseconds to delay before calling `resolve`. Typing
  during the debounce window resets the timer. Shows loading state immediately,
  calls `resolve` after the delay. Optional.

### How match works

The `match` function receives `{ value, cursor }` and decides:

1. **Is this source relevant?** Check prefixes, character positions, cursor
   location. Return `null` if not.
2. **Where does the replacement start?** Set `from` to the position where
   accepted text should be inserted.
3. **What's the filter query?** Extract the substring the user has typed
   so far for filtering.

The framework calls `match` on every edit. When completion is active, the
active source's `match` is checked first — if it returns `null`, the source
is deactivated and all sources are probed for a new match.

### Resolution Paths

**Sync, no debounce** (simplest):

```typescript
resolve: ({ query }) => items.filter((i) => i.label.startsWith(query));
```

Items appear instantly. No loading state.

**Async, no debounce:**

```typescript
resolve: async ({ query }) => {
  const results = await searchFiles(query);
  return results.map((f) => ({ label: f.name, value: f.path }));
};
```

Shows loading state while the Promise is pending. Previous items remain
visible during loading (no flicker). Stale results from superseded queries
are automatically dropped.

**Sync with debounce:**

```typescript
resolve: ({ query }) => items.filter(i => i.label.startsWith(query)),
debounce: 100,
```

Shows loading state immediately. Timer fires after 100ms of no typing.
Resolve runs, items appear. Previous items visible during loading.

**Async with debounce:**

```typescript
resolve: async ({ query }) => await searchAPI(query),
debounce: 200,
```

Loading state immediately. Timer fires after 200ms. Resolve starts, returns
Promise. Loading continues until Promise resolves. Stale results dropped.

## Registering Sources

```typescript
const editor = new LineEditor({ onSubmit: handleSubmit });

const unregister = editor.registerCompletion({
  id: "mention",
  match({ value, cursor }) {
    const idx = value.lastIndexOf("@", cursor - 1);
    if (idx < 0) return null;
    return { from: idx, query: value.slice(idx + 1, cursor) };
  },
  resolve({ query }) {
    return users
      .filter((u) => u.name.startsWith(query))
      .map((u) => ({ label: u.name, value: `@${u.name}`, description: u.role }));
  },
});

// Later, to remove:
unregister();
```

Multiple sources can be registered. On each edit, sources are checked in
registration order. First match wins.

### TUI/React Hook Pattern

```typescript
const editor = useLineEditor({ onSubmit: handleSubmit });

useEffect(() => {
  return editor.editor.registerCompletion(mySource);
}, [editor.editor]);
```

The hook exposes `editor.editor` (the raw `LineEditor` instance) for
registration. The `useEffect` cleanup function handles deregistration.

## CompletionState

When completion is active, `editor.state.completion` is non-null:

```typescript
interface CompletionState {
  readonly items: readonly CompletionItem[];
  readonly selectedIndex: number;
  readonly query: string;
  readonly loading: boolean;
  readonly sourceId: string;
  readonly from: number;
}
```

- **`items`** — Current results. During loading, holds the previous results
  (stale items) to avoid flicker. Empty array if no previous results.
- **`selectedIndex`** — Which item is highlighted. Preserved during loading.
  Reset to 0 when new results arrive.
- **`query`** — The query string returned by the source's `match`.
- **`loading`** — True while awaiting async resolve or debounce timer.
- **`sourceId`** — Which source is active.
- **`from`** — Replacement range start. On acceptance, the framework replaces
  `[from, cursor)` with `item.value`.

When completion is inactive, `editor.state.completion` is `null`.

## Keybindings (During Active Completion)

| Key        | Action                              |
| ---------- | ----------------------------------- |
| `Tab`      | Accept selected item                |
| `Enter`    | Accept selected item                |
| `Escape`   | Dismiss picker (text stays as-is)   |
| `Up`       | Select previous item (wraps around) |
| `Down`     | Select next item (wraps around)     |
| Other keys | Fall through to normal editing      |

When completion is NOT active, Tab and Escape are no-ops. Up/Down navigate
history as usual. Enter submits.

When completion IS active, these keys are intercepted BEFORE normal handling.
Up/Down navigate the picker, not history. Enter/Tab accept instead of
submitting.

## Post-Acceptance Chaining

After accepting a completion, the framework probes sources for a new match.
By default, the accepted source is skipped to prevent self-re-activation
(e.g., the command source would re-match `/help` since it starts with `/`).
Other sources are always probed — this enables cross-source chaining like
accepting `/attach ` from the command source immediately activating the
file source.

### `continues` — Same-Source Chaining

Set `continues: true` on a `CompletionItem` to opt into same-source
re-probing after acceptance. The canonical use case is directory drilling:
accepting `packages/` should immediately re-probe the file source to show
that directory's contents.

```typescript
items.push({
  label: entry.name + "/",
  value: `${pathPrefix}${entry.name}/`,
  description: "dir",
  continues: true, // re-probe this source after acceptance
});
```

Without `continues`, the accepted source is skipped and the picker closes.
With `continues`, the source's `match` is called with the post-acceptance
buffer. If it returns a match, `resolve` runs and the picker updates
in-place.

## CompletedRange Tracking

After accepting a completion, a `CompletedRange` is added to
`editor.state.completedRanges`:

```typescript
interface CompletedRange {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly sourceId: string;
}
```

Ranges track where completed text lives in the buffer. They are maintained
automatically:

- **Insert before range** — range shifts right
- **Insert after range** — range unchanged
- **Delete before range** — range shifts left
- **Edit overlapping range** — range is invalidated (removed)
- **Submit, history nav, setValue, clear** — all ranges cleared

Range adjustment uses a prefix/suffix diff algorithm to find the edit region.
This is efficient but has a known ambiguity with repeated characters at edit
boundaries — the outcome (shift vs invalidate) is always correct even when
the edit location identification is ambiguous.

### Use Cases

CompletedRanges enable:

- Semantic highlighting (color completed text differently)
- Badge/chip rendering for completed items
- Validation (detect if a completed file path was manually modified)

## Slash Commands

`@agentick/tui` provides a slash command system with built-in completion
integration.

### Built-in Commands

| Factory            | Command  | Description              |
| ------------------ | -------- | ------------------------ |
| `helpCommand()`    | `/help`  | Show available commands  |
| `clearCommand(fn)` | `/clear` | Clear message history    |
| `exitCommand(fn)`  | `/exit`  | Exit (aliases: `/quit`)  |
| `loadCommand()`    | `/load`  | Load command from a file |

### useSlashCommands Hook

```typescript
import { useSlashCommands, helpCommand, exitCommand } from "@agentick/tui";

const { dispatch, commands, addCommand, removeCommand } = useSlashCommands(
  [helpCommand(), exitCommand(exit)],
  { sessionId, send, abort, output: console.log },
);

// In your submit handler:
const handleSubmit = (text: string) => {
  if (dispatch(text)) return; // Returns true if text was a command
  send(text);
};
```

### Command Completion Integration

Wire slash commands into the completion system with
`createCommandCompletionSource`:

```typescript
import {
  useSlashCommands,
  useLineEditor,
  createCommandCompletionSource,
} from "@agentick/tui";

const { dispatch, commands } = useSlashCommands([...], ctx);
const editor = useLineEditor({ onSubmit: handleSubmit });

useEffect(() => {
  return editor.editor.registerCompletion(
    createCommandCompletionSource(commands),
  );
}, [editor.editor, commands]);
```

This registers a source that:

- Matches when the buffer starts with `/` and the cursor is in the command
  portion (before any space)
- Deactivates once the cursor passes a space, allowing other sources to
  take over (e.g., file completion after `/attach `)
- Resolves to matching command names with descriptions

### Custom Commands

```typescript
const myCommand: SlashCommand = {
  name: "model",
  description: "Switch the current model",
  args: "<model-name>",
  aliases: ["m"],
  handler: (args, ctx) => {
    ctx.send(`/set model ${args}`);
  },
};
```

Or load dynamically at runtime:

```
/load ./my-command.ts
```

The file must export `command` or `default` as a `SlashCommand`.

### CommandsProvider

Inject additional commands from a parent component:

```typescript
import { CommandsProvider } from "@agentick/tui";

<CommandsProvider commands={[myCommand]}>
  <Chat sessionId="main" />
</CommandsProvider>
```

## CompletionPicker (TUI)

Pure rendering component for terminal UIs. Takes `CompletionState` and
renders a windowed item list.

```typescript
import { CompletionPicker } from "@agentick/tui";

{editor.completion && <CompletionPicker completion={editor.completion} />}
```

Features:

- Emerald-themed border (`#34d399`)
- Inverse highlight for selected item
- Windowed scrolling (max 8 visible items)
- `...` indicators for items above/below the window
- Loading spinner
- "No matches" empty state
- Descriptions shown as dimmed text

Web/React consumers build their own picker using the same `CompletionState`
type from `@agentick/client`.

## Mutation Primitive Hierarchy

For contributors working on the `LineEditor` class itself. Four mutation
methods form a clear hierarchy:

1. **`_editValue(newValue, newCursor)`** — Raw mutation. Updates value/cursor,
   adjusts completed ranges. No notification. Used by `_applyEdit` and
   `_acceptCompletion`.

2. **`_update(value, cursor)`** — Wholesale reset. Dismisses active
   completion, clears completed ranges, notifies. Used by submit, history
   navigation, `setValue`, `clear`.

3. **`_applyEdit(newValue, newCursor)`** — Edit-aware. Calls `_editValue`,
   then runs the match/probe flow: if an active source still matches, resolve
   with updated context; if it doesn't, dismiss and probe all sources for a
   new match. Then notifies.

4. **`_acceptCompletion()`** — Completion-specific. Replaces `[from, cursor)`
   with the item's value, dismisses silently, calls `_editValue`, then probes
   all _other_ sources for chaining (skips the accepted source). Notifies.

### Notification Contract

- `_resolveNow` NEVER notifies for sync results — the caller (`_applyEdit`)
  handles notification.
- `_resolveNow` DOES notify for async results — the Promise `.then` callback
  calls `_notify` because the caller has already returned.
- Debounce timer callbacks call `_resolveNow` then `_notify` — they are
  deferred, so the original caller's `_notify` has already fired (for the
  loading state).
- `_resolveId` (monotonically increasing counter) prevents stale async
  results from applying. Every dismiss, re-resolve, or destroy increments it.

## Creating Custom Completion Sources

### File Search

```typescript
const fileSource: CompletionSource = {
  id: "file",
  match({ value, cursor }) {
    const idx = value.lastIndexOf("#", cursor - 1);
    if (idx < 0) return null;
    return { from: idx, query: value.slice(idx + 1, cursor) };
  },
  resolve: async ({ query }) => {
    const files = await glob(`**/*${query}*`, { limit: 20 });
    return files.map((f) => ({
      label: basename(f),
      value: f,
      description: dirname(f),
    }));
  },
  debounce: 150,
};
```

### @Mention

```typescript
const mentionSource: CompletionSource = {
  id: "mention",
  match({ value, cursor }) {
    const idx = value.lastIndexOf("@", cursor - 1);
    if (idx < 0) return null;
    return { from: idx, query: value.slice(idx + 1, cursor) };
  },
  resolve({ query }) {
    return agents
      .filter((a) => a.name.toLowerCase().startsWith(query.toLowerCase()))
      .map((a) => ({
        label: a.name,
        value: `@${a.name}`,
        description: a.description,
      }));
  },
};
```

### Slash Commands (manual)

```typescript
const commandSource: CompletionSource = {
  id: "command",
  match({ value, cursor }) {
    if (cursor < 1 || value[0] !== "/") return null;
    const spaceIdx = value.indexOf(" ");
    if (spaceIdx >= 0 && cursor > spaceIdx) return null;
    return { from: 0, query: value.slice(1, cursor) };
  },
  resolve({ query }) {
    return commands
      .filter((c) => !query || c.name.startsWith(query))
      .map((c) => ({
        label: c.name,
        value: `/${c.name}`,
        description: c.description,
      }));
  },
};
```

Or use `createCommandCompletionSource(commands)` which does exactly this.

## Testing

```bash
# Core engine (99 tests)
cd packages/client
npx vitest run src/__tests__/line-editor.spec.ts

# TUI components + hooks (153 tests)
cd packages/tui
npx vitest run --config vitest.config.ts
```

Test helpers for completion sources:

```typescript
function commandSource(items: CompletionItem[] = []): CompletionSource {
  return {
    id: "command",
    match({ value, cursor }) {
      if (cursor < 1 || value[0] !== "/") return null;
      const spaceIdx = value.indexOf(" ");
      if (spaceIdx >= 0 && cursor > spaceIdx) return null;
      return { from: 0, query: value.slice(1, cursor) };
    },
    resolve({ query }) {
      return query ? items.filter((i) => i.label.startsWith(query)) : items;
    },
  };
}
```

Key test scenarios covered:

- match activation and deactivation
- Query update on typing, filtering
- Accept (Return + Tab), dismiss (Escape)
- Backspace past `from` boundary dismisses
- Up/Down wrap-around navigation
- Multiple sources (first match wins)
- Post-acceptance cross-source chaining (command → file)
- Post-acceptance same-source chaining via `continues: true` (directory drilling)
- Async loading state and stale result rejection
- Debounced resolution with timer reset
- Debounce + async combined path
- Promise rejection handling
- Multiple CompletedRanges with shift/invalidation
- Loading state preserving stale items and selectedIndex
- Kill ring capped at 60 entries
- `destroy()` during active completion
