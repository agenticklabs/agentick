# Rendering

Terminal message rendering — converts content blocks to ANSI-styled strings
for console output (Ink scrollback area).

## Architecture

```
theme.ts         Color palette + formatDuration
    ↓
markdown.ts      Markdown → ANSI via marked-terminal (responsive width)
    ↓
content-block.ts Per-type ContentBlock rendering
    ↓
message.ts       Full message rendering (user vs assistant styling)
    ↓
index.ts         Re-exports
```

All functions return plain strings with ANSI escape codes. No React components
here — this is the pure-function layer that `console.log` consumes.

## Usage

```typescript
import { renderMessage, renderMarkdown, theme } from "@agentick/tui";

// Full message (auto-detects role, renders content blocks + tool calls)
console.log(
  renderMessage({
    role: "assistant",
    content: [{ type: "text", text: "Here's what I found:" }],
    toolCalls: [{ id: "tc_1", name: "search", duration: 342 }],
  }),
);

// Raw markdown rendering
console.log(renderMarkdown("**bold** and `code`"));

// Direct theme access
console.log(theme.toolName("search"));
```

## Message Styling

**User messages** render with subtle gray borders (top and bottom horizontal
rules) and muted text. Designed to be recognizable but not dominant in the
scrollback.

**Assistant messages** render content blocks with full markdown styling, plus
tool call indicators with optional durations.

No role labels — the visual styling differentiates.

## Content Block Support

Every `ContentBlock` type gets a dedicated renderer:

| Block Type                                    | Rendering                                   |
| --------------------------------------------- | ------------------------------------------- |
| `text`                                        | Full markdown → ANSI                        |
| `reasoning`                                   | Gray italic (redacted blocks skipped)       |
| `code`                                        | Fenced code block via markdown              |
| `executable_code`                             | Fenced code block via markdown              |
| `code_execution_result`                       | Dim output, red on error                    |
| `json`                                        | Syntax-highlighted JSON code fence          |
| `xml`                                         | XML code fence                              |
| `csv`, `html`                                 | Dim raw text                                |
| `tool_use`                                    | Skipped (rendered separately with duration) |
| `tool_result`                                 | Recursive content rendering, red on error   |
| `image`, `document`, `audio`, `video`         | Dim placeholder with metadata               |
| `generated_image`, `generated_file`           | Dim placeholder with name/URI               |
| `user_action`, `system_event`, `state_change` | Text or dim descriptor                      |

Unknown block types render as `[type]` in dim text.

## Responsive Width

The `Marked` instance is lazily created and cached by terminal width. When
`process.stdout.columns` changes (terminal resize), the next render call
creates a fresh instance with the new width. Maximum width is capped at 100
columns.

```typescript
import { getTerminalWidth } from "@agentick/tui";

const width = getTerminalWidth(); // min(columns, 100)
```

## Theme

All colors are defined in `theme.ts`. Single source of truth for the palette.

| Category   | Keys                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| Roles      | `user`, `assistant`, `system`                                                                           |
| Markdown   | `heading`, `firstHeading`, `strong`, `em`, `codespan`, `blockquote`, `hr`, `link`, `href`               |
| Content    | `toolName`, `toolDuration`, `toolSymbol`, `error`, `errorLabel`, `success`, `dim`, `label`, `reasoning` |
| Structural | `border`, `separator`, `muted`                                                                          |

`formatDuration(ms)` converts milliseconds to human-readable strings
(`342ms`, `1.2s`).
