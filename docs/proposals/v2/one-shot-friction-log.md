# One-Shot Dashboard — Friction Log (B1)

> **What this is.** The friction discovered while authoring the
> [one-shot dashboard prompt](./one-shot-dashboard-prompt.md) against the **real**
> `feat/v2` client surface. Every item here is a place where writing an
> *accurate* prompt required a hedge, a workaround, or a warning about a
> confusing/stale name. Per the B1 mandate: **each hedge the prompt needs is a
> discovered ergonomics defect.** This log is the B2 work list.
>
> Grounded against `packages-next/` on `feat/v2`. Sources cited by path so B2 can
> go straight to the seam. Severity: **blocker** (can't build the feature) /
> **high** (forces non-obvious workaround or is a correctness trap) / **medium**
> (papercut, extra glue) / **low** (docs / naming).
>
> **Confidence** on each item is my own assessment from reading source, not from
> running the build (B1 authored the prompt; running it is the next step).

---

## Ranked — Top 10

### 1. Knob descriptors are not on the wire — the client sees values, not schema
**Severity: HIGH.** Confidence: high.

`session.knobs` projects `KnobsState = Readonly<Record<string, KnobPrimitive>>`
— bare current values. The only knobs wire surface is `knobs/set` (write) and the
`knobs-state` channel (snapshot + JSON-Patch deltas of **values**). There is **no
`knobs/list`** or descriptor-enumeration method. `KnobDescriptor` (label, type,
min/max, enum options, group) lives only on the **server** `KnobsHarness.list()`
(`packages-next/spec/src/protocol/knobs-harness.ts:163`). A client that wants to
render labeled sliders / selects / toggles cannot discover the control shape — it
must infer from JS `typeof` (lossy: no bounds, no enum options, no labels) or
hydrate a descriptor list out-of-band server-side.

- **Files:** `packages-next/knobs/src/client/knobs-state-view.ts:29-30`;
  `packages-next/knobs/src/client/knobs-handle.ts`;
  `packages-next/spec/src/protocol/knobs-harness.ts:154-163`.
- **Suggested fix:** add a `knobs/list` (or fold descriptors into the
  `knobs-state` **snapshot** frame — the snapshot already re-materializes the
  store, so carrying `KnobDescriptor[]` there is cheap and drift-free). Then a
  `knobsDescriptorsView` / `session.knobs.descriptors` surfaces label/type/bounds/
  options/group. This is the single biggest "I can't build the obvious UI" gap.

### 2. No client wire path to read timeline history — scroll-back needs a server you build
**Severity: HIGH (known/deferred).** Confidence: high.

`timelineView` is a **fold over the live event stream** plus two manual splices
(`prepend`/`append`). It has no way to *read* durable history: the `initial` seed
and every `prepend` page must be fetched **server-side** from
`TimelineStore.history(...)` and shipped to the client through an endpoint the
adopter writes. A thin browser client cannot page its own scroll-back. The worked
reference (`example/v2-coding-agent/src/timeline-client-example.ts`) confirms this
is the intended shape — but it means "conversation scroll-back," a table-stakes
chat feature, is adopter homework.

- **Files:** `packages-next/timeline/src/client/timeline-view.ts:50-75, 101-163`;
  the reference recipe `example/v2-coding-agent/src/timeline-client-example.ts`.
- **Suggested fix:** a first-party read command
  (`session/timeline_history` → `{ entries, oldestSeq }`, paged by `seq`) and a
  `timelineView` option that lazy-loads older pages via it, so `view.prepend` is
  wired for the adopter instead of hand-rolled per app. This is explicitly a
  deferred item; B1 confirms it bites the first real dashboard.

### 3. `fromCursor` can't resume the live tail from a store hydrate (bus Cursor ≠ store seq)
**Severity: HIGH.** Confidence: high.

`timelineView({ initial, fromCursor })` wants a bus `Cursor` to resume the live
tail *after* the seeded history. But durable history is keyed by timeline `seq`,
and the live append events are keyed by bus `Cursor` — **two numbering systems**.
A store-only hydrate cannot produce the `Cursor`, so `fromCursor` stays
`undefined`, the client tails "from now," and there is a **race window**: appends
between the history read and the subscription open are either missed or
duplicated. The framework punts reconciliation of that overlap to the app (by
`message.metadata.clientId`), which only helps for the app's *own* optimistic
sends — not for a concurrent writer or an agent turn landing in the gap.

- **Files:** `packages-next/timeline/src/client/timeline-view.ts:22-34, 58-68`;
  `example/v2-coding-agent/src/timeline-client-example.ts:31-49` (the field doc
  candidly explains the gap).
- **Suggested fix:** unify the addressing — carry the bus `Cursor` as a tagged
  field on the durable entry at persist time (or have `history(...)` return the
  live-tail resume `Cursor` alongside `oldestSeq`), so a store hydrate yields a
  race-free resume point. Until then, snapshot-first on the timeline channel
  (like knobs/tasks) would eliminate the seam entirely.

### 4. `session.elicitations` is a property, but the docs/README call it `elicitations()`
**Severity: HIGH (correctness trap in the docs).** Confidence: high (85% — the
working example uses the property; the factory returns an object, not a function).

The registered slot is a **property** whose value is an `ElicitationsHandle`
(async-iterable + `.onChange` + `.respond` + `.close`). But the client-bundle
top-level JSDoc, the elicitation `/client` register/index docs, the spec docs,
and the `v2-coding-agent` README **all** write `session.elicitations()` — a call
— including `for await (const e of session.elicitations())`. Calling the property
throws "not a function." A developer copying any of those snippets writes broken
code on the first try. The one place that actually runs
(`example/v2-coding-agent/src/client.ts:72`) uses the property form
(`session.elicitations.onChange(...)`), proving the drift.

- **Files (drift):** `packages-next/client/src/index.ts:15`;
  `packages-next/elicitation/src/client/{index.ts:10,register.ts:6,13}`;
  `packages-next/spec/src/client/elicitation.ts:6`;
  `example/v2-coding-agent/README.md`. **Correct usage:**
  `example/v2-coding-agent/src/client.ts:72`.
- **Suggested fix:** decide one shape and sweep. Given the sibling handles
  (`session.knobs`, `session.tasks`) are also properties, keep the **property**
  and fix every `elicitations()` occurrence. Add a test that imports the bundle
  and asserts `typeof session.elicitations === "object"`.

### 5. Tool-confirmation ownership is a footgun — two paths race on the same reply
**Severity: MEDIUM-HIGH.** Confidence: high.

Tool confirmations are delivered as *ordinary elicitations* with
`hints.kind === "tool_confirmation"`. So they show up in **both**
`session.elicitations` (generic loop) **and** `session.confirmClientTools(policy)`.
If a dashboard wires a generic elicitation modal *and* a confirmation policy — the
natural thing to do — both respond to the same `correlationId`: last-responder-
wins / double-respond. The only guard is a prose caveat in the doc comment. The
accept **value shape** is also a hidden contract: a plain elicitation is
`accept(value)`, but a tool confirmation must be `accept({ approved: true })` —
undiscoverable without reading the gate's schema.

- **Files:** `packages-next/tool-executor/src/client/confirm.ts:1-98`
  (the caveat + the `{ approved: true }` shape).
- **Suggested fix:** either (a) filter `tool_confirmation` **out** of
  `session.elicitations` by default (make `confirmClientTools` the sole owner and
  give the generic stream everything else), or (b) surface a typed
  `session.toolConfirmations` handle distinct from `elicitations` so the split is
  structural, not a comment. Type the accept value per `hints.kind`.

### 6. No first-party React bindings for the client — every adopter re-hand-rolls `useSyncExternalStore`
**Severity: MEDIUM.** Confidence: high.

The live views (`timelineView`, `session.knobs`, `session.tasks`) are shaped to be
`useSyncExternalStore(view.subscribe, view.get)`-compatible — deliberately. But
there is **no `@agentick/client-next/react`** exporting `useTimeline`,
`useKnobs`, `useTasks`, `useElicitations`, `useSend`. Every React adopter writes
the same glue, and the streaming-delta batching (item #7) is exactly the kind of
subtle hook the framework should own once. The timeline reference even ships the
hook as a **commented-out** snippet, acknowledging the gap.

- **Files:** `example/v2-coding-agent/src/timeline-client-example.ts:107-119`
  (commented-out `useTimeline`); no `react` subpath under `packages-next/client*`.
- **Suggested fix:** a `@agentick/client/react` package (mirroring the
  `prompts-react` / `compiler-react` convention) with the store hooks + a
  batched-streaming `useSend` that folds `events()` on an animation frame. This is
  the single biggest ergonomics multiplier for the actual target audience.

### 7. Streaming deltas have no batching helper — the quadratic-markdown trap is unguarded
**Severity: MEDIUM.** Confidence: high.

`handle.events()` yields `content-delta` per token. The naive binding —
`setState(text => text + delta)` and re-render/re-parse markdown each time — is
quadratic and visibly stutters. The framework ships the fine-grained stream
(correct) but no batching/accumulation utility, so every adopter must independently
learn the lesson and hand-roll rAF batching + a stream-event reducer. The prompt
has to *teach* this defensively.

- **Files:** `packages-next/spec/src/data/streaming.ts` (the event union is right;
  there's just no consumer-side accumulator for it on the client).
- **Suggested fix:** ship a client-side `streamAccumulator` / `foldStreamEvents`
  (there is a server-side `stream-accumulator.ts` in `@agentick/model-next` —
  expose an equivalent client fold) and a batched `useSend` hook (see #6). Turns a
  known footgun into a one-liner.

### 8. Client send handle is synchronous while the server's is a ProcedurePromise — asymmetry to explain
**Severity: MEDIUM.** Confidence: high.

Server-side, `session.send(...)` is a `ProcedurePromise` you `await` (or
`await .result`). Client-side, `session.send(...)` returns a
`ClientSessionExecutionHandle` **synchronously** — no `await` on the send, but the
RPC + progress-stream stitching happens under the hood and `.result` is the
promise. Anyone porting server code to the client (or reading the CLAUDE.md
"everything is a Procedure / `await proc().result`" model) will `await` the send
and get a resolved handle whose `events()` they've already missed the start of.

- **Files:** `packages-next/client-core/src/handles.ts:140-142, 196-258`.
- **Suggested fix:** document the asymmetry loudly at the `send` slot, and/or make
  the client handle safely `await`-able (thenable resolving to itself) so both
  spellings work. At minimum: subscribe-before-send guidance (also relevant to
  #9).

### 9. Request channels (elicitation, client-tool-call) are live-only — subscribe-before-send or miss it
**Severity: MEDIUM.** Confidence: medium (depends on server replay behavior I did
not exercise).

Elicitation and client-tool-call streams filter the live subscription to `request`
envelopes and **opt out** of the snapshot fold (each frame is a discrete request,
not state). So a request emitted *before* the client attaches its subscription can
be missed — there is no "here are the currently-pending requests" snapshot at
connect. For a dashboard that resumes a session with an in-flight elicitation
(agent already blocked waiting on the user), the pending ask may not re-surface.
This contradicts the "enumeration is foundational for client wire surfaces" memo:
status-keyed-by-known-id / live-only is a leaky boot story.

- **Files:** `packages-next/elicitation/src/client/elicitations.ts:66-114`;
  `packages-next/tool-executor/src/client/client-tool-calls.ts:100-144`.
- **Suggested fix:** a snapshot-first frame on the request channels (the pending
  set), or an `enumerate` RPC for outstanding elicitations / suspended tool calls,
  so a freshly-connected client can rehydrate blocked requests. Verify current
  server replay before sizing.

### 10. `session.queue(...)` is a dangling wire stub with no server handler
**Severity: LOW-MEDIUM (trap).** Confidence: high.
**RESOLVED (onBusy redesign):** `session/queue` deleted end-to-end; the
semantic is `send({ onBusy: "queue" })` (`delivery` was renamed `onBusy`,
`"followUp"` → `"queue"`). Historical text below unchanged.

`session.queue(messages)` exists on the client handle and issues
`session/queue`, but the method is a **dangling wire stub** — no gateway handler,
no `SessionHarnessProtocol.queue`. Its intended "enqueue for after the session
settles" semantic is now owned by `send({ delivery: "followUp" })`. A developer
who discovers `queue` in the type surface and uses it gets a silent no-op /
MethodNotFound.

- **Files:** `packages-next/client-core/src/handles.ts:154-166` (the TODO(4b)
  admits it).
- **Suggested fix:** delete `session.queue` + its wire params (the CLAUDE.md
  "no backwards compat" rule applies — remove, don't deprecate), and point the
  JSDoc at `send({ delivery: "followUp" })`. Named in the STATUS 4b sweep already.

---

## Additional (below the top 10)

### 11. `FakeLanguageModelExecutor` is named as the test double, but adopters want `scriptedAdapter`
**Severity: LOW.** Confidence: high. The B1 charter and docs name
`FakeLanguageModelExecutor` as the "test without tokens" story, but its
constructor takes raw substrate handles (`scopeId, journal, bus, inbox, options`
— `packages-next/model-executor/src/fake-language-model-executor.ts:220-226`) and
is a framework-internal harness fake. The ergonomic adopter path is
`createApp({ model: scriptedAdapter("...") })`
(`@agentick/model-next/testing`). **Fix:** point adopter-facing docs at
`scriptedAdapter` via the `model` slot; reserve `FakeLanguageModelExecutor` for
harness-internal tests. (Naming: post-cut `LanguageModelExecutor` rename is
already tracked.)

### 12. Cross-origin dev is silently fatal without `allowedOrigins`
**Severity: LOW (docs).** Confidence: high. The safe-by-default web-security
policy rejects the Vite dev origin (`localhost:5173` is cross-origin to the API
port) with a bare `403` and no hint. Correct and intentional, but a first-run dev
hits a wall with no signal pointing at `allowedOrigins`.
- **Files:** `packages-next/transport/src/server/web-security.ts:240-268`.
- **Fix:** a dev-mode log line on a rejected cross-site request naming the
  `allowedOrigins` knob; a documented "serve client same-origin in prod" note.

### 13. `session.knobs.set(key, value)` uses `key`, but the harness op input is `{ id, value }` / `{ name }`
**Severity: LOW.** Confidence: medium. The client write sends `{ sessionId, key,
value }` (`knobs-handle.ts:50`) while the server-side inputs speak `id` /
`name` (`KnobsSetInput`, `KnobsDispatchInput`). Cosmetic vocabulary drift across
the boundary; not a bug, but a reader comparing the two sides stumbles.
**Fix:** align the wire param name to `id`.

### 14. `client.events()` has surfaces with no live source yet
**Severity: LOW.** Confidence: high. `client.events()` is documented as an
observability stream over `connection` / `request` / `subscription` / `auth` /
`wire` / `extension` surfaces, but only `connection` has a live emit source today
(`packages-next/client-core/src/client.ts:584-600` TODO). A dashboard that tries
to observe request/subscription lifecycle from `events()` gets silence. Use
`onStateChange` / `onLog` / `onProgress` for now. **Fix:** wire the remaining emit
sites (tracked as #308-followup).

---

## Meta-observation

The **read path is strong** where state is snapshot-first and folded (knobs,
tasks) — those bind to React in one line and are a pleasure. The friction
concentrates in three seams: **(a) discovery** — the client can enumerate neither
knob descriptors nor timeline history nor pending requests without adopter-built
server endpoints (items #1, #2, #9); **(b) React ergonomics** — no first-party
hooks and no streaming-batch helper, so every adopter re-derives the same glue and
re-learns the quadratic-markdown lesson (#6, #7); and **(c) doc/name drift** —
`elicitations()` vs the property, `queue` vs `delivery`, `FakeLanguageModelExecutor`
vs `scriptedAdapter` (#4, #10, #11). (a) is the architecturally interesting bucket
and should anchor B2; (b) is the highest-leverage quick win for the actual
audience; (c) is a same-day sweep.
