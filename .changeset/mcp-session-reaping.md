---
"@agentick/mcp": patch
---

Sessions count activity on every inbound message (both transports), so the idle
reaper no longer force-closes live in-process sessions at 30 minutes of age.
`sessions.maxSessions` is implemented (default 1000): at the cap the
least-recently-active session is evicted through the full close chain; new
clients are never rejected.
