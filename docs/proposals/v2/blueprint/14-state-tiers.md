# 14 — State Tiers

**Status:** Synthesized with placeholders
`[SOURCE: compiler-harness.md, runtime.md, harness-principle.md, executor.md, cluster.md]`

This doc consolidates **where state lives, who owns it, and how it
survives transitions**. Four tiers, each with a distinct lifetime and a
distinct owner. v1 conflated several of these (the COM tried to be both
fiber-tree-equivalent AND persistent state); v2 splits them properly.

## The four tiers at a glance

```
Tier              Lifetime                       Owner               Browser analog
────────────────────────────────────────────────────────────────────────────────────
Reactive tree     until rerender                 reconciler harness       DOM
Session-side      until session close            Session harness     localStorage,
                  (with hibernate/restore)                            cookies, history
Active resources  until Scope ends               Effect Scope        process state,
                  (entity deactivation,                              open file handles
                   session close, unmount)
Persistent        until explicit deletion        Persistence backend disk
```

Plus an outer ring:

```
Compile output    one tick                       renderTree      HTML (rendered output)
                  artifact, not state
```

## Detailed tier table

| State element                                  | Tier                         | Owner                                | Persists across hibernate?                     | Persists across crash?             | Browser analog   |
| ---------------------------------------------- | ---------------------------- | ------------------------------------ | ---------------------------------------------- | ---------------------------------- | ---------------- |
| `useState` / `useReducer` cells                | Reactive tree                | reconciler harness fiber             | yes (compiler snapshot)                        | yes (in snapshot)                  | React state      |
| `useSignal` cells                              | Reactive tree                | reconciler harness                   | yes (compiler snapshot)                        | yes                                | React state      |
| Pending async component promises               | Reactive tree                | reconciler harness                   | canceled on hibernate; re-run on restore       | re-run                             | n/a              |
| `useData` resolved cache                       | Reactive tree                | reconciler harness (runtime-bridged) | yes (Layer 2)                                  | yes                                | sessionStorage   |
| Tool `use:` deps                               | Reactive tree (per render)   | reconciler harness                   | recaptured on next render                      | recaptured                         | n/a              |
| Active mountId                                 | Reactive tree                | reconciler harness                   | unmounted on hibernate; new mountId on restore | new on restore                     | window           |
| Timeline entries                               | Session-side / Persistent    | Session + persistence                | yes (incremental write)                        | yes                                | history          |
| Knob values                                    | Session-side / Persistent    | Session + persistence                | yes                                            | yes                                | localStorage     |
| Channel pointers (lastSequence, retention)     | Session-side / Persistent    | Session + persistence                | yes                                            | yes                                | n/a              |
| Channel events (recent buffer)                 | Session-side / Persistent    | Channel store                        | yes (per retention policy)                     | yes                                | n/a              |
| Subscription intents                           | Session-side / Persistent    | Session + persistence                | yes                                            | yes                                | service workers  |
| Resolve cache (Layer 1)                        | Session-side / Persistent    | Session + persistence                | yes                                            | yes                                | sessionStorage   |
| Spawn parent reference                         | Session-side                 | Session                              | yes (parentSessionId; ref re-resolved)         | yes                                | n/a              |
| Knob declarations (schemas)                    | Reactive tree                | reconciler harness                   | re-collected on render                         | re-collected                       | n/a              |
| Sandbox connection                             | Active resources             | Scope                                | NO — released                                  | NO                                 | running process  |
| MCP client connections                         | Active resources             | Scope                                | NO — released                                  | NO                                 | running process  |
| Open file handles                              | Active resources             | Scope                                | NO                                             | NO                                 | open files       |
| In-flight provider stream                      | Active resources             | Scope                                | aborted                                        | aborted                            | open fetch       |
| Tool handler in progress                       | Active resources             | Scope                                | aborted                                        | aborted                            | open fetch       |
| Loop executor's tick state                     | Active resources             | Scope (per execution)                | aborted; partial state in timeline             | timeline entry preserved           | n/a              |
| Per-session PubSub                             | Active resources             | Scope                                | re-created on activate                         | re-created                         | n/a              |
| Compiler-private snapshot                      | Persistent (when hibernated) | Session snapshot record              | yes                                            | yes                                | n/a              |
| Session record (status, currentTick, metadata) | Persistent                   | Persistence backend                  | yes                                            | yes                                | n/a              |
| App configuration (rootElement, opts)          | App-level                    | App harness (in process)             | n/a                                            | n/a (re-instantiated on app start) | application code |
| Cluster routing table                          | Cluster-level                | Cluster framework                    | n/a (cluster-managed)                          | yes (cluster persists)             | DNS              |
| Auth identity                                  | Per-request                  | Gateway                              | no                                             | no                                 | session cookie   |

## Tier 1 — Reactive tree

```
What's here:
  ─ React fiber tree (mounted, alive while the session is active)
  ─ useState, useReducer cells
  ─ useSignal cells
  ─ Suspended async component promises
  ─ useData cache (Layer 2)
  ─ React Context graph (provider values)
  ─ Captured `use:` deps for tools

Lifetime:
  ─ Created on react.mount (per session activation)
  ─ Updated on rerender
  ─ Persisted to compiler snapshot on hibernate
  ─ Released on react.unmount

Browser analog: DOM
```

The reactive tree is the **DOM** of v2. It's where React lives. v1's COM
tried to be a parallel reactive tree; v2 is honest about React being the
reactive tree itself.

## Tier 2 — Session-side state

```
What's here:
  ─ Timeline entries (the conversation history)
  ─ Knob values (model-visible reactive values)
  ─ Channel state (named streams + pointers + retention)
  ─ Subscription intents (long-lived primitive declarations)
  ─ Resolve cache (Layer 1: persisted via useResolved)
  ─ Per-session immutable metadata (id, parentSessionId, tenantId)
  ─ Usage stats accumulator

Lifetime:
  ─ Created on session creation
  ─ Mutated by commands (send, dispatch, append, channel.publish, knob.set)
  ─ Persisted incrementally to backend
  ─ Hydrated on activation (windowed timeline + full session record)
  ─ Released on session close

Browser analog: localStorage, cookies, history
```

This is what makes a session **a session**. It's the persistent
identity-and-history of the conversation. The session harness owns it
through the persistence backend; the reconciler harness reads it through hook
bridges.

### Why incremental persistence

`[SOURCE: runtime.md (earlier) §Decision Log]`:

> v1 lesson — dumping all session state at hibernation produced bloated
> snapshots, slow restores, forced deserializing everything to wake.

v2 splits storage:

```
Session record           one row per session, small structured fields
                         saved on session lifecycle transitions

Timeline entries         one row per entry, indexed by (sessionId, sequence)
                         appended incrementally as each entry commits

Channel events           per-channel append-only log
                         retention-bounded
                         (Tier 2 storage may be Redis Streams in cluster mode)

Large content            blob storage (S3, GCS) for items > inline threshold
                         referenced by content-addressed id from timeline rows

Compiler snapshot        small structured payload stored on the session record
                         (only present when hibernated)
```

Hydration on activation loads:

1. Session record (one row, fast).
2. Compiler snapshot (small).
3. Timeline window (configurable; not full history).
4. Knob values (small).
5. Subscription intents (small; re-registered with supervisor).

The full timeline is queryable but not loaded eagerly. Older entries
stay durable; the runtime fetches windows on demand for the React
harness's `useTimeline()` queries.

## Tier 3 — Active resources

```
What's here:
  ─ Sandbox connections (process, container, VM, remote)
  ─ MCP client connections
  ─ Open file handles
  ─ In-flight provider stream
  ─ Tool handlers currently executing
  ─ Per-session PubSub instance
  ─ Loop executor's tick-scoped Effects
  ─ Subscription receivers (the supervisor's actual connections)

Lifetime:
  ─ Created lazily as needed (component mount, tool dispatch, ...)
  ─ Released when the binding Scope ends:
      ─ Tool dispatch Scope ends with tool result
      ─ Tick Scope ends with tick:terminal
      ─ Execution Scope ends with execution:terminal
      ─ Session Scope ends with hibernate or close

Browser analog: process state, open file handles, fetch in flight
```

Active resources are **Scope-bound**. Each level of the harness stack
opens a Scope; finalizers run when the Scope ends. This is structural
cleanup — no `try/finally` ceremony, no leak on error paths.

```
Session Scope (open while active)
  ├─ Per-session PubSub
  ├─ MCP clients (long-lived)
  ├─ Sandbox connection (long-lived)
  └─ Execution Scope (open per execution)
      ├─ Loop fiber
      └─ Tick Scope (open per tick)
          ├─ Provider stream
          └─ Tool dispatch Scopes (parallel children)
              └─ Tool handler invocation
```

When the session hibernates, the Session Scope ends → all child Scopes
end → all active resources release. Restoration creates fresh Scopes;
resources are re-created on demand.

`[V1-REPLACED]` of v1's scattered cleanup (manual `onDestroy` chains,
explicit close calls). v2 leans entirely on Effect Scope.

## Tier 4 — Persistent state

```
What's here:
  ─ Session records
  ─ Timeline entries
  ─ Channel events (within retention)
  ─ Large content (blobs)
  ─ Subscription routing entries (in supervisor)
  ─ Compiler snapshots (when hibernated)
  ─ Cross-session indexes (by tenant, by parent session, etc.)

Lifetime:
  ─ Persists until explicit deletion or TTL expiration
  ─ Survives crash, migration, redeployment

Browser analog: disk
```

Persistent state lives in pluggable backends (Postgres, Redis, SQLite,
S3 for blobs). The persistence interface lives in `@agentick/spec-next`:

```ts
interface PersistenceBackend {
  // Session record
  saveSession(record: SessionRecord): Effect<void, PersistenceError>;
  loadSession(id: string): Effect<SessionRecord | null, PersistenceError>;
  deleteSession(id: string): Effect<void, PersistenceError>;

  // Timeline (incremental)
  appendEntry(sessionId: string, entry: TimelineEntry): Effect<void, PersistenceError>;
  loadEntries(sessionId: string, window: EntryWindow): Effect<TimelineEntry[], PersistenceError>;
  queryEntries(sessionId: string, query: EntryQuery): Effect<TimelineEntry[], PersistenceError>;

  // Channel storage (per channel, per session)
  appendChannelEvent(
    sessionId: string,
    channel: string,
    event: ChannelEvent,
  ): Effect<void, PersistenceError>;
  readChannelEvents(
    sessionId: string,
    channel: string,
    range: ChannelRange,
  ): Effect<ChannelEvent[], PersistenceError>;
  trimChannel(
    sessionId: string,
    channel: string,
    retention: ChannelRetention,
  ): Effect<void, PersistenceError>;

  // Content (blobs)
  saveContent(ref: ContentRef, content: Content): Effect<void, PersistenceError>;
  loadContent(ref: ContentRef): Effect<Content, PersistenceError>;
}
```

`[PLACEHOLDER]` shape — the source proposals reference this interface
without enumerating it fully; synthesized from `runtime.md (earlier
draft) §Backend interface`. Sign-off needed.

## Composable persistence (Layer-based)

Per `[SOURCE: runtime.md (earlier) §Configuration shape]`:

```ts
// Simple: one backend handles everything
createApp(<Agent />, {
  persistence: postgresPersistence({ url: "..." }),
});

// Composed: different stores per concern
createApp(<Agent />, {
  persistence: {
    sessions: postgresPersistence({ url: "..." }),  // session records, timeline
    channels: redisPersistence({ url: "..." }),     // hot channel buffer
    content: s3Persistence({ bucket: "..." }),       // blobs
  },
});
```

The runtime accepts a `PersistenceLayer` (or a record of Layers, one per
concern). Each backend factory returns a Layer that satisfies one or more
persistence interfaces.

## Compiled context is a projection

```
Persistent timeline           the full chronology, queryable, durable
       │
       ▼
Compiled context              what the model sees this tick:
                               ─ a window of recent entries
                               ─ summarized older entries
                               ─ retrieved relevant entries
                               ─ live state from sections
```

The compiled context is a **projection** of the timeline, not the
timeline itself. Sliding windows, summarization, RAG retrieval — all are
projection strategies that operate on stored timeline data without
requiring the full timeline in memory.

The runtime's job: provide structured access to timeline storage. Let
user code (or framework-level patterns) decide what projection to use.

`[V1-INHERITED]` of v1's `<Timeline />` component which already supports
windowing.

## Hibernate / restore mechanics

```
Hibernate:
  1. Run hibernate-scope interceptors (defer/veto possible).
  2. Pause inbox; finish active tick if any.
  3. react.snapshot(mountId) → ReconcilerSnapshot (small, structured).
  4. Build SessionSnapshot envelope:
       { sessionId, parentSessionId, status, currentTick,
         knobs, subscriptionIntents, resolveCache,
         channelPointers, compilerSnapshot, usage,
         timestamp }
  5. persistence.saveSession(snapshot)  (one write)
  6. End Session Scope → all Tier 3 resources release
       (sandbox, MCP, PubSub, etc.)
  7. status = hibernated

Restore:
  1. persistence.loadSession(sessionId) → snapshot
  2. Open new Session Scope
  3. Hydrate Tier 2 from snapshot:
       knobs, subscriptionIntents, resolveCache,
       channel pointers (events stay in channel storage)
  4. Re-register subscriptionIntents with supervisor
       (the supervisor was holding routing state externally,
        so this is a re-bind, not a full re-mat)
  5. react.restore({ rootElement, snapshot.compilerSnapshot, hookBridges })
       → fresh mountId
       Re-mounts the React tree; useResolved reads from resolveCache
       instead of re-running async loaders for entries with cache hits
  6. Pull timeline window per useTimeline() hook queries
  7. status = idle (ready for next message)
```

The key invariants:

- **Tier 3 resources are NEVER persisted.** They are recreated on
  restore.
- **Tier 1 reactive state IS persisted via the compiler snapshot**, but
  small structured (not full fiber tree).
- **Tier 2 session-side state IS persisted**, incrementally where
  possible (timeline entries one-by-one).
- **The supervisor (in cluster mode) holds the actual external
  connection** for `<Subscription>` etc.; the session only holds the
  intent. This is what lets sessions hibernate aggressively.

## Compiler snapshot shape

`ReconcilerSnapshot` is small, structured, and JSON-serializable. The
runtime stores it as a `jsonb` column on the session record (one row);
no separate snapshot table needed. See `03-reconciler-harness.md` §Snapshot
rules for the full type and behavior.

Quick recap of what's in:

| In snapshot                                 | Where it lives in code           |
| ------------------------------------------- | -------------------------------- |
| `useState` / `useReducer` cell values       | per `(componentPath, hookIndex)` |
| `useSignal` cell values                     | same indexing                    |
| `useData` Layer-2 cache                     | keyed by user cache key          |
| Pending async component paths               | bare list                        |
| Active renderer scope stack                 | `FormatterRef[]`                 |
| Compile diagnostics + suppressed-cell audit | `FormatDiagnostics`              |

Quick recap of what's NOT in:

```
useRef                ─ transient; never persisted
useEffect cleanup     ─ React invariant; re-runs on re-mount
React Context         ─ rebound from runtime services
Suspense state        ─ components re-suspend naturally
mountId               ─ new id assigned on restore
knob declarations     ─ re-collected on re-render (declarations are tree-derived)
knob values           ─ Tier 2 (session.knobs)
session.resolveCache  ─ Tier 2 Layer 1 cache
```

Non-serializable cell values are dropped silently with a one-time
diagnostic per offender; see `03-reconciler-harness.md` for the rule.

## Session record shape

```ts
interface SessionRecord {
  // Identity
  sessionId: string;
  parentSessionId: string | null;
  metadata: Record<string, unknown>;

  // Lifecycle
  status: SessionStatus;
  currentTick: number;
  createdAt: number;
  lastActiveAt: number;
  hibernatedAt?: number;

  // Compiler-private state (only when hibernated)
  compilerSnapshot?: ReconcilerSnapshot;

  // Tier 2 state (small, structured)
  knobs: Record<string, KnobState>;
  subscriptionIntents: SubscriptionIntent[];
  resolveCache: Record<string, ResolvedValue>;
  channelPointers: Record<string, { lastSequence: number; retention: ChannelRetention }>;

  // Cumulative
  usage: UsageStats;

  // App / cluster placement (in cluster mode)
  appId?: string;
  cluster?: { nodeId?: string; shard?: number };
}
```

Differs from v1's `SessionSnapshot` (which embedded `timeline` directly).
Timeline is queried separately via `loadEntries`.

## Timeline entry shape

```ts
interface TimelineEntry {
  // Stable identity
  id: string;
  sessionId: string;
  sequence: number; // monotonic per session
  tick: number; // tick this entry belongs to

  // Persistence metadata
  createdAt: string; // ISO 8601
  executionId?: string;

  // Content envelope
  kind: "message" | "event" | "tool_call" | "tool_result";
  message?: Message; // when kind === "message"
  event?: ProtocolEvent; // when kind === "event"
  toolCall?: ToolCall; // when kind === "tool_call"
  toolResult?: ToolResult; // when kind === "tool_result"

  // Optional storage references
  largeContentRefs?: ContentRef[]; // for blobs stored separately
}
```

`[V1-INHERITED, REFINED]` from `packages/shared/src/timeline.ts` and
`packages/core/src/com/types.ts:COMTimelineEntry`. The v2 entry stays
JSON-serializable (no `Formatter` reference, no `SemanticContentBlock`
in the persisted shape — content rendering is a runtime concern that
operates over the raw `Message` content).

## Storage tier defaults

```
Tier 0 (single-process / dev):
  persistence: in-memory
  channels: in-memory
  content: in-memory or local fs

Tier 1 (single-server prod):
  persistence: SQLite or Postgres
  channels: in-memory (lost on restart) or Redis
  content: local fs or S3

Tier 2 (multi-server / cluster):
  persistence: Postgres (durability + queryable timeline)
  channels: Redis Streams or NATS JetStream
  content: S3 / GCS
  cluster bus: same as channels

High-throughput:
  persistence: Postgres or sharded equivalent
  channels: NATS JetStream
  content: S3 / GCS
  cluster bus: NATS or Kafka
```

## Resolve cache layers

`[GAP]` (deferred from `03-reconciler-harness.md`) — the proposals reference
`useResolved` as "Layer 2 of the resolve mechanism" without naming
Layer 1.

Blueprint position `[PROPOSAL]`:

```
Layer 1 (persistent resolves):
  ─ useResolved<T>(key) reads from session.resolveCache (Tier 2)
  ─ Values placed there by explicit session.resolve(key, value) calls
    or by useData with persist: true
  ─ Persists across hibernate / restore / crash

Layer 2 (compile-time resolves):
  ─ useData<T>(loader) caches in compiler snapshot (Tier 1)
  ─ Re-runs loader on cache miss
  ─ Persists across hibernate via compiler snapshot
  ─ Default ttl per app config; per-call override
```

Sign-off needed.

## Spawn relationships

```
Parent session
   │
   ├── ephemeral spawn (default)
   │     ─ Tier 2 state of child not registered in app
   │     ─ child closes when run completes
   │     ─ parent retains a live ref while child runs
   │
   └── persistent spawn (cluster-promoted; opt-in)
         ─ Tier 2 state persisted as a normal session
         ─ child is a registered cluster entity
         ─ parent retains parentSessionId; child carries it too
         ─ child can outlive parent's current execution
```

`[V1-INHERITED, EXTENDED]` from v1's spawn (always ephemeral). v2 cluster
mode allows persistent spawn for delegation patterns. `[GAP]` — the
exact opt-in mechanism (`session.spawn(component, input, { persist: true })`?)
is not specified. Sign-off needed.

## Multi-tenant isolation

State isolation between tenants is structural:

- Per-session entity boundaries (each session is its own actor in cluster
  mode, its own object in library mode).
- Per-tenant indexes on persistence backends.
- Per-tenant shared resource accounting (rate limiters, caches).
- Per-tenant scoped event subscribers
  (`app.events({ scope: { tenantId } })`).

Cross-tenant access is impossible by default; opt-in is via app-level
interceptors that can read across tenants (e.g., admin observability).

## Decisions captured

- Four state tiers: reactive tree, session-side, active resources,
  persistent.
- Compiler snapshot is small and structured (not opaque).
- Timeline is persisted incrementally; not embedded in the session
  record.
- Tier 3 resources (sandboxes, MCP, streams) are released on hibernate
  and recreated on restore.
- Compiled context is a projection of the timeline.
- `useResolved` is Layer 1 (persistent); `useData` is Layer 2
  (compile-time cache).
- Persistence is Layer-based and composable.
- Subscription intents persist; supervisor holds the actual external
  connections.

## Open questions

- `ReconcilerSnapshot` shape (placeholder; sign-off — most consequential).
- Default timeline window size on hydration.
- Channel default retention (lean: 256 entries OR 30 min).
- `useResolved` Layer 1 vs Layer 2 naming (lean: per above).
- Persistent spawn opt-in mechanism (lean: `{ persist: true }`).
- Large-content inline threshold (default).
