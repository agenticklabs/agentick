---
"@agentick/client": patch
"@agentick/angular": patch
---

feat: paginated message history + Angular service cleanup

- Add `prependMessages()` to MessageLog, ChatSession, and ChatSessionService for loading older messages on scroll-back
- Rewrite AgentickService: remove `providedIn: "root"`, eliminate polling RxJS fallback, proper cleanup of client subscriptions, use `inject()` exclusively
