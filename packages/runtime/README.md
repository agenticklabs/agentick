# @agentick/runtime

In-process substrate for Agentick v2. Provides the default implementation
of the `@agentick/spec` protocol interfaces:

| Implementation     | Spec interface                       |
| ------------------ | ------------------------------------ |
| `MemoryJournal`    | `OperationJournal`                   |
| `LocalEventBus`    | `EventBus`                           |
| `LocalInbox`       | `MessageInbox`                       |
| `BaseHarness`      | (not a spec interface — base class)  |

`BaseHarness` is the inheritance point every concrete harness sits on
top of. It composes journal + bus + inbox into the five-surface model
(commands, inbox, lifecycle handlers, middleware, events) described in
`docs/proposals/v2/blueprint/01-harness-principle.md`.

This package is **in-process only**. Distribution (cluster) and
persistence (postgres/sqlite/redis) are separate packages that
implement the same `@agentick/spec` protocol interfaces.

## Status

Phase 2 of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md`.
