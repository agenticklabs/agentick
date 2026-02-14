---
"@agentick/client": minor
"@agentick/react": minor
"@agentick/tui": minor
---

Extract LineEditor as framework-agnostic class in @agentick/client. Readline-quality line editing (13 actions, kill ring, history, keybindings) now available to all platforms. Add useLineEditor hook to @agentick/react for web consumers. TUI's useLineEditor becomes a thin Ink-specific wrapper.
