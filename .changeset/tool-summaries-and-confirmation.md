---
"@agentick/core": minor
"@agentick/shared": minor
"@agentick/tui": minor
"@agentick/sandbox": minor
---

Tool call summaries and file confirmation with diff preview.

Tools can define `displaySummary` to provide a short description (e.g., file
path, command) that appears in stream events and TUI indicators.

File modification tools (`write_file`, `edit_file`) now require confirmation
before execution. A new `confirmationPreview` hook computes a unified diff
that renders in the TUI confirmation prompt.

Fixed: session confirmation channel wiring (was previously unconnected).
