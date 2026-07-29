---
"@agentick/runtime": minor
"@agentick/session": minor
"@agentick/timeline": minor
"@agentick/knobs": minor
"@agentick/state": minor
"@agentick/resources": minor
"@agentick/prompts": minor
"@agentick/skills": minor
"@agentick/gates": minor
"@agentick/tasks": minor
"@agentick/elicitation": minor
"@agentick/subscriptions": minor
"@agentick/credentials": minor
"@agentick/tool-executor": minor
"@agentick/live": minor
"@agentick/mcp": minor
---

`EventScope.sessionId` has exactly one authority.

Deciding it was previously each harness's own job. **Every session-owned harness got
it wrong, the same way**: `sessionId: this.scopeId`. Timeline, knobs, state,
resources, prompts, skills, gates — and MCP, whose scope key is doubly composed
(`<sessionId>:mcp:<serverId>`).

The two values are one string-concatenation apart and mean different things:

| axis          | question              | for a session sub-harness |
| ------------- | --------------------- | ------------------------- |
| `scopeId`     | which WORK unit am I? | `<sessionId>:timeline`    |
| `principal`   | on WHOSE behalf?      | `acme/user-42`            |
| `parentScope` | inside WHAT?          | `{ sessionId }`           |

`scopeId` has to stay composed — it is the inbox address root
(`<surface>:<scopeId>`) and the backing store key, so two harnesses on one session
would collide without the suffix. But the gateway narrows a
`{ kind: "session", id }` subscription to `scope.sessionId === id`, so an envelope
announcing itself from `"s1:timeline"` never satisfied a subscription to `"s1"`.

**Nothing errored.** Each subscription opened, matched nothing, and stayed open. Every
client-side live projection over those surfaces was dead — timeline tails, knob state
frames, MCP notifications — and the symptom that finally surfaced it was a chat panel
showing a user's message followed by silence.

Two things made it near-undetectable. The declaration seam's own docstring offered
`() => ({ sessionId: this.scopeId })` as the example to copy. And `session-bridges.ts`
carried this comment five times, about the _previous_ fact that had gone missing the
same way:

> the cascade must be TOTAL, not "whichever bridge someone remembered to thread"

`parentScope` was then threaded to 2 of 7 bridges by exactly that method. Hand-threading
is the bug generator, not the bug.

## What changed

**One axis, one merge point.** `BaseHarnessOptions.parentScope` is the third identity
axis beside `scopeId` and `principal`. `runOperation` folds it into the resolved scope
as the outermost layer of the precedence chain that already existed — harness
construction < ambient crossing < the op's own dims — so **both** the `RuntimeContext`
a handler/guard/hydrator reads via `getContext` **and** every envelope `makeEvent`
builds derive from the same value. Merging it only into the envelope would have given
a guard a different answer than a subscriber: two authorities for one coordinate.

**Every self-stamp deleted.** Seven scope factories and every inline
`{ sessionId: this.scopeId }` are gone. A command that adds no dims of its own now
declares no scope at all.

**Eight options interfaces now `extend BaseHarnessOptions`** (tasks, elicitation,
knobs, resources, subscriptions, credentials, MCP) and forward the whole bag to
`super`. Standing alone, each silently dropped every base option a caller passed —
`MCP`'s `super(...)` took no options whatsoever — so the next slot the base gains would
have vanished the same way.

**`sessionScoped()` in `session-bridges.ts`** assembles the standard bag once. Adding
an eighth bridge means calling it; forgetting a fact is no longer expressible.

## Enforcement (the point)

Two gates, each proven to fail when the bug returns:

- **`spec-conformance/event-scope-authority.spec.ts`** — a text sweep over every
  package's `src` that fails on `sessionId: this.scopeId`, naming `file:line`. Text
  rather than behavioural on purpose: it has to catch a harness written next year by
  someone who never read any of this. One escape hatch, `NOT AN EVENT SCOPE`, for the
  sites where the composed key is genuinely right (store keys, data payloads) — a
  reviewer has to state the claim.
- **`session/bridge-scope-authority.spec.ts`** — the omission case, which no grep can
  see: it reads `harness.parentScope` off the assembled `HookBridges` bundle, so a new
  surface is covered the moment it appears there. It also asserts the value is NOT the
  scope key, because `parentScope: { sessionId: scopeId }` would satisfy a naive check
  while reintroducing the exact bug.

## Known gaps, marked

`TODO(store-ctx-key-name)` — `StoreCtx.sessionId` is a store KEY, and there the
composed `scopeId` is correct. One field name carrying two concepts is the same disease
one layer down, and it is what made a blind sweep of this pattern silently empty
timeline genesis mid-refactor. It should be `logKey`.
