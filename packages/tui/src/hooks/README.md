# TUI Input System

## Overview

The TUI input system provides readline-quality line editing for Ink-based
terminal UIs. It replaces `ink-text-input` with a proper editing engine:
cursor movement, word navigation, kill/yank, history, and transposition.

Three layers:

- **`LineEditor`** (from `@agentick/client`) — Framework-agnostic class with
  all editing logic. Buffer, cursor, kill ring, history, keybindings. Accepts
  normalized keystroke strings. No React dependency.

- **`useLineEditor`** — Thin Ink-specific React hook wrapping `LineEditor`.
  Converts Ink's `(input, Key)` to normalized keystrokes via
  `normalizeInkKeystroke`, integrates with `useSyncExternalStore`.

- **`RichTextInput`** — React component that renders the hook's state.
  Cursor shown as inverse character. Handles placeholder, empty, and
  inactive states.

`InputBar` (the user-facing component) wires the hook and renderer together.
Consumers don't need to interact with them directly.

## Keybindings

All standard readline bindings:

### Movement

| Key         | Action                 |
| ----------- | ---------------------- |
| `Ctrl+A`    | Beginning of line      |
| `Ctrl+E`    | End of line            |
| `Ctrl+F`    | Forward one character  |
| `Ctrl+B`    | Backward one character |
| `Alt+F`     | Forward one word       |
| `Alt+B`     | Backward one word      |
| `Alt+Right` | Forward one word       |
| `Alt+Left`  | Backward one word      |
| `Left`      | Backward one character |
| `Right`     | Forward one character  |

### Deletion

| Key         | Action                               |
| ----------- | ------------------------------------ |
| `Backspace` | Delete character before cursor       |
| `Ctrl+H`    | Delete character before cursor       |
| `Ctrl+D`    | Delete character at cursor (forward) |

### Kill & Yank

| Key      | Action                            |
| -------- | --------------------------------- |
| `Ctrl+K` | Kill from cursor to end of line   |
| `Ctrl+U` | Kill from start of line to cursor |
| `Ctrl+W` | Kill word backward                |
| `Alt+D`  | Kill word forward                 |
| `Ctrl+Y` | Yank (paste) last killed text     |

Killed text accumulates in a kill ring (stack). `Ctrl+Y` always pastes
the most recently killed text. The kill ring is per-component-instance.

### Transposition

| Key      | Action                         |
| -------- | ------------------------------ |
| `Ctrl+T` | Transpose characters at cursor |

At end of line: swaps the last two characters.
Mid-line: swaps the character before cursor with the character at cursor,
then advances cursor.

### History

| Key     | Action                                     |
| ------- | ------------------------------------------ |
| `Up`    | Previous history entry                     |
| `Down`  | Next history entry / restore current input |
| `Enter` | Submit and add to history                  |

History is per-component-instance. On submit, the untrimmed input is saved.
Navigating up saves the current (unsaved) input; pressing down past the
newest entry restores it.

### Passthrough

These keys are explicitly NOT consumed by the editor:

- `Ctrl+C` — handled by parent (abort/exit)
- `Ctrl+L` — handled by parent (clear screen)
- `Tab` — reserved for future completion
- `Escape` — reserved for future completion

## Architecture

### LineEditor class (in `@agentick/client`)

The core editing logic lives in a framework-agnostic `LineEditor` class.
It follows the same snapshot + `onStateChange` pattern as `MessageSteering`
and `ChatSession`:

```typescript
import { LineEditor } from "@agentick/client";

const editor = new LineEditor({ onSubmit: (text) => console.log(text) });
editor.handleInput(null, "hello"); // insert text
editor.handleInput("ctrl+a", ""); // move to start
editor.handleInput("return", ""); // submit
```

### Key normalization

The TUI layer converts Ink's `(input: string, key: Key)` to normalized
keystroke strings via `normalizeInkKeystroke`:

- `Ctrl+A` → `"ctrl+a"`
- `Alt+F` → `"meta+f"`
- Arrow keys → `"up"`, `"down"`, `"left"`, `"right"`
- Special → `"return"`, `"backspace"`, `"delete"`, `"tab"`, `"escape"`
- `Alt+Arrow` → `"meta+left"`, `"meta+right"`

Each UI layer (web, Angular, etc.) provides its own normalizer.

### Word boundaries

Standard readline word boundary detection: words are sequences of `\w`
characters (`[a-zA-Z0-9_]`). Non-word characters are skipped.

## Testing

```bash
cd packages/tui
npx vitest run
```

Test files:

- `hooks/use-line-editor.spec.ts` — Ink key normalization tests
- `hooks/use-line-editor.integration.spec.tsx` — 34 integration tests that
  render real Ink components, simulate keystrokes via stdin, and verify
  rendered output
- `components/InputBar.spec.tsx` — 10 component tests for InputBar's API

Pure action/class tests live in `@agentick/client`
(`packages/client/src/__tests__/line-editor.spec.ts`).

## Ink Key Parsing Note

Ink maps the physical Backspace key (`\x7f`) to `key.delete`, not
`key.backspace`. This is why both `backspace` and `delete` bindings
map to `deleteBackward`. Forward delete is `Ctrl+D` (standard readline).

In the test environment, `\x7f` also maps to `key.delete`. The integration
tests use `\x08` (Ctrl+H) for backward delete, which works consistently
in both environments.
