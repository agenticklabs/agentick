# Internal visibility — stamping the spine (Backlog stream F, preliminary)

**Status:** PROPOSED (for Ryan). The FIRST of two F increments. This one lands the
durable disposition — a uniform `internal` facet stamped down the session spine —
plus an interim client-side hide. The principal-gated _delivery edge_ (server-side
undelivery) is the SECOND increment, deferred; because the stamp is the durable
foundation, the edge lands later with **no re-stamp**.

**Decision (Ryan, 2026-08-25):** option **B** — a uniform `internal` facet now;
the `visibility` → `audience` rename is its own later consistency pass.

## 0. TL;DR

The client must never see certain executions / messages / blocks — "undelivered,
not hidden." This increment makes each of those _stampable_ as `internal` and
propagates the stamp down the spine so the leaves are self-describing. The bus and
the journal stay whole (truthful — telemetry/observers/ground-truth see
everything); only the _edges_ redact, and for now the edge is the client hiding
what it's told is internal. Server-side principal-gated undelivery is the next
increment.

## Usage (adopters)

Mark content the **model should see but the client should not**. Set `internal: true` — it propagates down the session:

```ts
// A whole session — every turn, message, and tool call it produces.
const session = await app.createSession({ internal: true });

// A single turn.
await session.send({ internal: true, messages: [{ role: "user", content: "…" }] });

// A spawned / forked sub-agent — its whole session.
await session.spawn({ internal: true, send: { messages } });
const worker = await session.fork({ internal: true });

// A tool — its calls and results, wherever it is used.
const debug = createTool({ name: "debug_info", internal: true, inputSchema, handler });
```

The model still reads internal content in its context; the client's timeline never shows it. The event **bus** and the durable **journal** keep the complete record — telemetry, observers, and ground-truth see everything.

**It propagates down the spine.** `internal` is inherited: an internal session makes every turn internal; an internal turn makes every message it produces internal; an internal parent's whole spawn subtree is internal; an internal tool's calls and results are internal. Set it once, at the level you mean — you never stamp children by hand.

**What "hidden" means today.** The content is _stamped_ `internal` and the client UI hides it. Full server-side _undelivery_ — the client never receives it over the wire, gated by the viewer's permissions so an admin can still see everything — is the next increment (§5). Tool-level and block-level declarations are also next; today the knobs are `createSession` and `send`.

> Design note: if this section needed more than two examples and a one-line rule to explain, the interface would be wrong. It doesn't — one uniform `internal: true` knob, one propagation rule.

## 1. The concept — two axes, and where `internal` sits

The codebase has three half-overlapping words; naming them straight is half the work:

- **`exposure`** — who may _INVOKE_ a capability (`ToolExposure` = `model`/`dispatch`/`runtime`; `CommandExposure` = `internal`/`addressable`/`wire`). Reachability. **Stays a separate axis** — invocation is not sight.
- **`audience`** — who _SEES/RECEIVES_ content (and a capability's products). This is the axis F extends. It is really the 2×2 of `{ model-sees, client-sees }`, and the existing `visibility` enum already _is_ that 2×2 in disguise.

| `visibility`        | model | client |
| ------------------- | ----- | ------ |
| `"model"` (default) | ✓     | ✓      |
| `"observer"`        | ✗     | ✓      |
| `"log"`             | ✗     | ✗      |
| `"internal"`        | ✓     | ✗      |

So `internal` is not a new concept — it is the last empty cell (`{ model:true, client:false }`). The journal is always-on ground truth, not a facet.

**This increment (B):** introduce `internal` as a **uniform `internal?: boolean`
declaration knob** at every spine level, stamped onto each leaf's existing audience
carrier (`visibility:"internal"` on a message, `metadata.internal` on a block). We
do NOT rename `visibility` → `audience` or restructure it into facets yet — every
level speaking the same `internal` knob makes that later rename mechanical.

## 2. The invariant — each layer stamps its products

Propagation is purely **local**. Each layer:

```
effectiveInternal = inheritedFromParent || ownDeclaration
→ stamp my immediate products with effectiveInternal
→ hand effectiveInternal down as the child's `inherited`
```

No central resolver and no containment walk at read — each layer **denormalizes the
resolved bit onto what it produces**, so a leaf is always self-describing. This also
means persistence is query-ready (a later `{ includeInternal }` store filter is a
flat predicate, no join up the spine) and the bus/journal stay whole (stamping is
production-side _metadata_, never delivery-side _dropping_).

The plumbing has a precedent: this is exactly how `executionId` threads today (the
runtime carries `currentExecutionId`, every append reads it and stamps —
`packages/session/src/harness.ts:4103`). `internal` rides the **same rail** — a
`currentExecutionInternal` beside `currentExecutionId`, read at the same stamp site.
It is a second value on an existing channel, not new machinery.

## 3. Declaration points and carriers

Five places may declare `internal`; each is the same `internal?: boolean` knob:

| Declare at                    | Carrier                                                                 | Stamps                                           |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| `createSession({ internal })` | `SessionRecord.internal?` _(new persisted field)_                       | every message + block in the session             |
| `send({ internal })`          | `SendInput.internal?` → `runtime.currentExecutionInternal`              | every message + block of that execution          |
| a tool, at creation           | `ToolAnnotations.internal?` _(new field)_                               | that tool's `tool_use` calls + its `tool_result` |
| a message                     | append / send-message option → `visibility:"internal"` _(value exists)_ | that message (covers its blocks)                 |
| a block                       | `metadata.internal` _(open bag, exists)_                                | that one block (partial redaction)               |

**Migration:** exactly **one** new persisted field — `SessionRecord.internal?`
(optional; same downstream-adapter round-trip note as `interruptedExecutionId` /
`resumeAttempts`: `KnowifySessionStore` carries it in the adopting bump). Everything
else rides existing homes. No schema migration.

**Resolution per layer:**

- `createSession` → `SessionRecord.internal`.
- `send` → `execution.effective = session.internal || send.internal`, parked on the runtime execution state.
- append (message) → `message.effective = execution.effective || message.explicit` → stamp `visibility:"internal"`.
- blocks → covered by the message; `metadata.internal` only adds the partial case.
- tool dispatch → `(tool_use / tool_result).effective = execution.effective || tool.internal` → stamp.

**Producer gap to close:** the public append path currently DROPS `visibility`
(`appendEntryBody`, `packages/session/src/harness.ts:4051-4058`) — it must thread it,
or nothing stamps.

## 4. Interim delivery (this increment)

- **Bus + journal stay whole.** Stamping never withholds; the full spine is recorded.
- **Revert the two server-side filters** added during exploration — `publishProduced`
  and `historyPage` in `packages/timeline/src/harness.ts` must NOT drop `internal`
  (they filter the shared bus / a read edge unconditionally, which contradicts
  truthful-bus and principal-relative delivery).
- **Client render hides internal.** The client render filter today drops only
  `"log"` (`packages/timeline/src/react/timeline.tsx:146`); extend it to also drop
  `visibility:"internal"` and `metadata.internal` blocks. Hidden, not undelivered —
  good enough until the edge lands.

## 5. The filtering phase — principal-gated delivery (second F increment)

**Status:** DESIGNED, not built. The stamping phase (§§1–4) is pure and additive:
it makes content _carry_ `internal` but nothing acts on it, so the framework runs
exactly as before. This phase is where the stamp is _honored_ — an admin principal
sees everything, a normal client never receives internals. It changes behavior
deliberately, gated by the viewer's capability. It lands with **no re-stamp** (the
durable foundation is already in place).

### 5.1 The capability — how a principal earns visibility

The principal is just an identity (a string, ADR 48); "can this viewer see
internal?" is a **capability derived from it**, and only the adopter can compute it
(the framework can't interpret their scopes). So:

- The framework owns a finite vocabulary: `interface PrincipalCapabilities {
readonly includeInternal?: boolean }` (extensible later).
- The adopter fills it **at authentication**, where they already turn credentials
  into an identity: `AuthSource.authenticate` returns `{ principal, tokenScopes,
capabilities }`. This is the one place with both the credential and the meaning of
  the adopter's roles. Scopes never reach the framework as policy — they're
  translated here.
- It rides the connection, resolved **per-connection** (stable; re-resolved on
  reconnect) → onto the ctx → `StoreCtx.capabilities` (pull) and the connection
  (push).

Resolution layers, highest-wins:

1. **No `AuthSource`** (local/trusted pole) → `includeInternal: true`. Solo dev sees
   everything, zero config.
2. **`AuthSource` returns explicit `capabilities`** → used verbatim (full control,
   e.g. "our `support` role → true").
3. **`AuthSource`, no explicit capabilities** → the **sugar**: derive from a
   well-known scope in `tokenScopes` (`internal:read`). Needs no adopter code beyond
   _issuing the scope_.
4. **Otherwise** → `false` (safe default).

It is **capability-based, not ownership-based**: even a session's _owner_ is a
normal client and does not see internal (it's machinery); only a principal granted
`includeInternal` (admin / support / debug) does.

### 5.2 The two doors — where the capability is applied

**Pull — store reads take `{ includeInternal }` (default false; the store enforces
the already-denormalized leaf filter):**

- `timeline.history` — drop internal entries from the scroll-back page.
- `session.list` / `pageSessions` — drop internal _sessions_ (`record.internal`).
- `session.get` / `getSessionRecord` — withhold an internal session's content.
- `session/search` (stream D, future) — same predicate.

The wire read-handler reads the connection's capability and passes the flag.
NOT filtered: `timeline.read()` / the in-memory projection — that's the _model's_
tier, and the model is meant to see internal.

**Push — the per-connection funnel is the single redaction seam:**

`dispatchRequest`'s projected sink is per-connection (knows `includeInternal`),
universal (every notification + RPC result funnels through it), and already a
content projector (the tool-output size-bounder). One policy sits beside it — for a
connection **without** `includeInternal`:

- a `StreamEvent` stamped internal → **drop the frame**;
- a timeline-append envelope → **drop the internal entries from its payload**;
- the raw `emitDelta` bus (if a client subscribed) also funnels here → covered.

This is why the bus/journal stay whole and there is **no ADR-102 violation**: the
bus stays scope-topological and truthful (telemetry/observers/ground-truth see
everything); redaction is a _transport delivery_ projection, per-connection and
per-principal — exactly like the size-bounder, not a bus-subscription filter.
"Undelivered, not hidden": the frame never leaves the server for an unauthorized
viewer; an admin connection gets the identical stream unredacted.

### 5.3 Also deferred

The `visibility` → `audience{model,client}` **consistency rename** — every level
already speaks `internal`, so it becomes mechanical.

### 5.4 Tests this phase adds (end-to-end)

The stamping phase's suite (§8) is the safety net; the filtering phase adds:

- **Capability resolution:** no-`AuthSource` → `includeInternal` true; explicit
  `AuthSource` caps → verbatim; `internal:read` scope → true (sugar); otherwise
  false.
- **Pull:** `history`/`list`/`get` with `includeInternal:false` omit internal
  entries/sessions; with `true`, return them unchanged; the cursor/pagination stays
  exact across the filter.
- **Push (the guarantee):** a connection without the capability receives NO internal
  `StreamEvent` and NO internal entry in an append envelope; an admin connection
  receives the identical stream _including_ internals. The **bus/journal still carry
  everything** (assert the truthful record is intact behind a redacted delivery).
- **Composition:** an internal spawn subtree delivered to a normal client shows the
  parent's non-internal output but none of the sub-agent's internal machinery, while
  an admin sees the whole tree.

## 6. Edit list (this increment)

1. `SessionRecord.internal?` (+ adapter round-trip note) · `CreateSessionInput.internal?` → stamps it.
2. `SendInput.internal?` → `runtime.currentExecutionInternal` (new, beside `currentExecutionId`).
3. `ToolAnnotations.internal?` → `tool_use` / `tool_result` stamping in the loop/tool dispatch.
4. Per-message append/send-message option; per-block `metadata.internal`.
5. `appendMessageEntryFx` / `appendInputMessageFx`: compute `effectiveInternal`, stamp, and STOP dropping `visibility` in the public path.
6. Revert `publishProduced` + `historyPage` filters (bus/journal truthful).
7. Client render filter hides `visibility:"internal"` + `metadata.internal`.
8. Tests: each declaration point → leaf stamp (session / send / tool / message / block); the bus + journal still carry internal; the client hides it.

## 7. Status (uncommitted)

**LANDED (typecheck green: spec, session, app):**

- `visibility` union gained `"internal"` — the message-level carrier (audience 2×2 cell).
- **Spec knobs:** `CreateSessionInput.internal`, `SendInput.internal`, `SessionRecord.internal` (+ adapter round-trip note).
- **Runtime rail** (`session-state.ts`): `isInternal()` (durable session rung) + live `currentExecutionInternal()` (execution rung), threaded through `SessionRuntimeInit` → record.
- **Session-level** wired end-to-end: `createSession({ internal })` → harness opts → runtime → `record.internal`.
- **Execution + message stamping** (`harness.ts`): `sendBody` folds `session || send` into the live rail before the input append, clears at execution end; `appendMessageEntryFx` stamps `visibility:"internal"` (explicit visibility wins).
- **Client hide** (`react/timeline.tsx`): render drops `"internal"` alongside `"log"`.
- **Reverted** the exploratory `publishProduced`/`historyPage` filters + their tests — bus/journal truthful.

**DEFERRED (own surgical increments — the append site can't see tool annotations, so tool-level belongs in the tool-executor/loop, not here):**

- **Tool-level** — `ToolAnnotations.internal` → stamp `tool_use` + `tool_result`, in the tool-executor/loop where the declarations live. (Not added as a dead knob until it's wired.)
- **Block-level partial** — `metadata.internal` on a single block within a delivered message (adopters can stamp at persistence today).
- **F-edge** — the principal-gated delivery edge (§5).

First consumer: the delegation tools — async-delivery marks the injected completion message `internal` via `send({ internal: true })`.
