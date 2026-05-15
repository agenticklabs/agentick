# Flow A — Cold Start and Mount

**Status:** Synthesized

The first time the runtime sees a session — either because user code
called `app.session(id)` for a new id, or because a hibernated session
is being activated by an arriving message — these are the things that
happen in order.

## Library mode (Tier 0/1)

```mermaid
sequenceDiagram
  autonumber
  actor user as User code
  participant app as App harness
  participant sess as Session harness
  participant react as reconciler harness
  participant rend as Formatter harness
  participant pers as Persistence

  user->>app: createApp with MyAgent and opts
  app->>app: install services (renderers, executors, persistence, telemetry)
  app-->>user: App handle

  user->>app: app.session(user-123)
  app->>app: registry lookup
  alt session id known but hibernated
    app->>pers: loadSession(user-123)
    pers-->>app: SessionRecord with compilerSnapshot
  else fresh session
    app->>app: instantiate SessionHarness
  end
  app-->>user: Session handle

  user->>sess: send messages
  Note over sess: status idle to running

  sess->>react: mount with rootElement and hookBridges
  react->>react: reconcile initial tree
  react->>react: collect render scopes
  loop per render scope
    react->>rend: render(input)
    rend-->>react: FormattedContent
  end
  react-->>sess: mountId
  sess->>sess: emit session:lifecycle:mount:terminal

  sess->>sess: open Session Scope (per-session PubSub etc.)

  Note over sess,react: tree is LIVE for this session, mountId persists across executions
```

The session harness ALWAYS mounts the React tree at session activation,
NOT per execution. The mountId stays valid across many `send` /
`dispatch` / `render` calls. It only goes away on hibernate or close.

## What "alive" means

Once mounted:

- `useState`/`useReducer`/`useSignal` cells are live; setters update them.
- `useEffect` and lifecycle hooks (`useOnMount`) have fired.
- Long-lived primitives (`<Subscription>`, `<Cron>`, `<Webhook>`,
  `<EventListener>`) have registered intents.
- Renderer providers are in scope.
- React Context (sandbox, MCP, custom) is bound.
- `useData` may have started loaders (suspended subtrees may be
  awaiting).

The tree exists independent of any execution. A `renderTree` call
takes a snapshot of the current tree state; it doesn't define when the
tree exists.

## Hibernated session: activation

```mermaid
sequenceDiagram
  autonumber
  participant ext as External event
  participant sup as App Supervisor
  participant pers as Persistence
  participant sess as Session harness
  participant react as reconciler harness

  ext->>sup: deliver to sessionId user-123
  sup->>pers: loadSession(user-123)
  pers-->>sup: SessionRecord, status hibernated
  sup->>sess: activate (rehydrate from record)

  Note over sess: status hibernated to restoring

  sess->>sess: hydrate Tier 2 state from record

  sess->>react: restore with rootElement, compilerSnapshot, hookBridges
  react->>react: re-mount tree
  react->>react: replay reactive cells from snapshot
  react->>react: useResolved reads from resolveCache
  loop pending async with no cache
    react->>react: re-run the await
  end
  react-->>sess: mountId (new value)

  sess->>sup: re-register subscriptionIntents
  sup->>sup: confirm routing entries still valid

  sess->>sess: emit session:lifecycle:restore:terminal

  Note over sess: status restoring to idle or running

  alt pending message triggered restore
    sess->>sess: deliver message, run execution
  end
```

Restoration order matters:

1. **Session record loaded first** — small, fast.
2. **Tier 2 state hydrated** — knobs, intents, resolveCache, channel
   pointers. All small structured data.
3. **reconciler harness restored** — the tree re-mounts, replays cells from
   the compiler snapshot, runs `useResolved` against the resolveCache.
   Async components without a cached resolve re-run their loaders.
4. **Subscription intents re-registered** with the supervisor. The
   supervisor's external connections (webhooks, cron timers) typically
   stayed alive while the session was hibernated, so this is a re-bind,
   not full re-materialization.

## Cluster mode

```mermaid
sequenceDiagram
  autonumber
  actor user as User code
  participant cl as Cluster routing
  participant node as Runtime Node N
  participant app as App harness (per node)
  participant sess as Session entity
  participant pers as Persistence (shared)

  user->>cl: app.session(user-123).send(msg)
  cl->>cl: which node hosts user-123
  alt entity not active anywhere
    cl->>cl: shard, pick node by consistent hash
    cl->>node: activate entity
    node->>app: instantiate Session entity
    app->>pers: loadSession(user-123)
    pers-->>app: SessionRecord
    app->>sess: hydrate and mount as in library mode
    Note over sess: same Tier 2 and React restore steps
  else entity already on Node X
    cl->>node: forward message to Node X
  end
  node->>sess: deliver send(msg)
  Note over sess: from here identical to library mode
```

The cluster wrapper adds:

- Routing layer (consistent hash → node).
- Activation across nodes (one entity, one node at a time).
- Migration if the hosting node leaves.

User code is identical. The Session reference returned from
`app.session(id)` is a typed cluster entity reference in cluster mode
(commands go through the cluster's typed-message routing) and a direct
in-process object in library mode.

## Events emitted during cold start

Approximate sequence on a fresh session created via library `app.session(id)`:

```
app:session:created:terminal { sessionId }
session:lifecycle:mount:requested
session:lifecycle:mount:before
reconciler:mount:requested
reconciler:render:requested            (if renderTree was called for a first send)
reconciler:render:delta                (per stable-iteration)
reconciler:render:terminal             { iterations, forcedStable }
formatter:format:* (per scope)
reconciler:mount:terminal               { mountId, succeeded }
session:lifecycle:mount:terminal   { succeeded }
```

If the session is hibernated and being restored:

```
app:session:restored:terminal      { sessionId }
session:lifecycle:restore:requested
session:lifecycle:restore:before
reconciler:restore:requested
reconciler:restore:terminal             { mountId, succeeded }
session:subscription:registered:terminal × N (re-binds)
session:lifecycle:restore:terminal { succeeded }
```

## What can fail

| Failure | Where it surfaces |
| --- | --- |
| Persistence load timeout | `RestoreError` from session.restore |
| Compiler snapshot corrupt or wrong spec version | `RestoreError` with `cause: VersionMismatch` |
| Async component throws on re-run after restore | `reconciler:async:resolved` with `outcome: failed` → loop's `reconciler:render:terminal { failed }` |
| Subscription handler ID no longer in tree | `session:subscription:handler-unbound:terminal` per intent |
| Cluster node unavailable for activation | `cluster:activation:terminal { failed }` (then routing retries) |

## Cross-references

- `03-reconciler-harness.md` for `mount`, `restore`, `renderTree` details.
- `08-session-harness.md` for session lifecycle states.
- `11-cluster.md` for activation, supervisor, migration.
- `14-state-tiers.md` for what's in the snapshot vs what's hydrated
  separately.
