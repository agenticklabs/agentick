# MCP parity audit — what agentick v2 has, lacks, and refuses

**Status: AUDIT.** Not a proposal, not a plan. 2026-07-30, `feat/v2` @
`cbfdae13`. Target spec: `2025-11-25` official + `draft` (what
`packages/mcp/package.json` pins), with the tasks augmentation and the icons /
MCP-Apps metadata direction folded in.

## Method

Every feature gets one of four verdicts:

- **have** — the seam exists natively AND both projections work (in via
  `McpClientHarness`, out via `McpServerHarness`) where the feature is
  bidirectional.
- **partial** — some surfaces exist. Named exactly, using the four-surface lens
  from `completions.md`: **client edge** (agentick consuming a remote MCP
  server), **server edge** (agentick projecting itself as an MCP server),
  **native middle** (the harness/spec seam both edges share), **agentick wire**
  (our own gateway verb).
- **missing** — no native seam. The **null hypothesis is steel-manned first**:
  why the primitives we already have might suffice, decomposed concretely, with
  the standing verdicts cited (no command vertical; no Action supertype;
  tool-is-the-action; compose primitives, not subsystems). Only then what a
  native seam would earn. Verdict: **build / defer / decompose**.
- **deliberately-not** — refused on principle, principle stated.

Every `have` / `partial` claim carries a `file:line` verified this session.

The headline: **parity is much better than the working memory of it.** All five
gaps recorded from the Knowify port are closed. What remains is not a missing
vertical — it is three small correctness defects, one real asymmetry, and
exactly one genuine architectural question (sampling).

---

## Server features

| Feature                                                                | Verdict                                                 | Evidence                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tools/list` · `tools/call` · `list_changed`                           | **have**                                                | `packages/mcp/src/server/projection/tools.ts:167`, `:181`, `:310`                                                  |
| Tool `outputSchema` + `structuredContent`                              | **have**                                                | `projection/tools.ts:358`, `:280`; envelope at `server/config.ts:975`                                              |
| Tool `annotations` (readOnly/destructive/idempotent/openWorld)         | **have**                                                | `server/wire-extensions.ts:67`; projected `projection/tools.ts:372`                                                |
| Tool `title` + `icons`                                                 | **have**                                                | `projection/tools.ts:361`, `:364`                                                                                  |
| Tool `_meta` — declaration and result (MCP Apps `ui://`, step-up auth) | **have**                                                | `wire-extensions.ts:78`, `:95`; projected `projection/tools.ts:369` and `:286`; result read `server/config.ts:982` |
| Tool `taskSupport` → wire `execution`                                  | **have**                                                | `projection/tools.ts:392`                                                                                          |
| Tool result content blocks → MCP content union                         | **partial** (defect)                                    | raw cast, `projection/tools.ts:278` — see §1                                                                       |
| `tools/list` pagination                                                | **have** (2026-07-30)                                   | pages the post-filter view via the shared `paginate`, `projection/tools.ts:182`                                    |
| `prompts/list` · `prompts/get` · `list_changed`                        | **have**                                                | `projection/prompts.ts:79`, `:93`, `:149`                                                                          |
| Prompt `title`                                                         | **partial** (defect)                                    | declared `packages/spec/src/protocol/prompts-harness.ts:154`, dropped by `projection/prompts.ts:178` — see §2      |
| Prompt `icons` / `_meta`                                               | **missing**                                             | no field emitted, `projection/prompts.ts:178`                                                                      |
| Prompt message content beyond text                                     | **partial**                                             | non-text blocks `JSON.stringify`'d, `projection/prompts.ts:213`                                                    |
| `prompts/list` pagination                                              | **have** (2026-07-30)                                   | projection `projection/prompts.ts:101`; native wire row `prompts/wire-augment.ts` → `{ prompts, nextCursor? }`     |
| `resources/list` · `read` · `templates/list` · `list_changed`          | **have**                                                | `projection/resources.ts:95`, `:130`, `:112`, `:217`                                                               |
| `resources/subscribe` · `unsubscribe` · `updated`                      | **have**                                                | `projection/resources.ts:175`, `:198`, `:186`                                                                      |
| Resource pagination (cursors, both list verbs)                         | **have** — the only paginated harness                   | `spec/src/protocol/resources-harness.ts:159`; threaded `projection/resources.ts:102`, `:119`                       |
| Resource contents `_meta`                                              | **have**                                                | `projection/resources.ts:269`                                                                                      |
| Resource descriptor `icons` / `_meta`                                  | **missing** (`title` present)                           | `projection/resources.ts:235`                                                                                      |
| Embedded resources in results                                          | **have** inbound, **partial** outbound                  | `integration/content-mapper.ts:121`; outbound shares §1                                                            |
| `completion/complete` — `ref/prompt`                                   | **have**, declaration-seam-backed                       | `projection/completions.ts:142`; three-arm resolution `:170`                                                       |
| `completion/complete` — `ref/resource`                                 | **partial** — config handlers only, no declaration seam | `projection/completions.ts:33`, `:303`                                                                             |
| Completion 100-value cap at the wire                                   | **have**, and correctly located                         | `projection/completions.ts:87`                                                                                     |
| `logging/setLevel` + `notifications/message`, RFC-5424 severities      | **have**                                                | `projection/logging.ts:89`, `:113`, severities `:55`                                                               |
| Pagination generally                                                   | **have** — one shared helper                            | see §3                                                                                                             |

## Client features

Agentick as the MCP _client_ — the capabilities a server may invoke on us.

| Feature                          | Verdict                            | Evidence                                                                                                                                                                        |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roots/list` + `list_changed`    | **have**, both directions          | client sends: `client/harness.ts:1505`, `:1362`, source resolve `:1389`; server ingests: `server/projection/roots.ts:54`                                                        |
| `elicitation/create` — form mode | **have**, both directions          | server issues `server/projection/elicitation.ts:287`; client serves into `ElicitationHarness` via `client/elicit-bridge.ts:111`                                                 |
| `elicitation/create` — URL mode  | **have**, both directions          | `server/projection/elicitation.ts:323`, wire shape `:201`                                                                                                                       |
| `sampling/createMessage`         | **partial** — raw passthrough only | client edge: adopter handler `client/types.ts:186`, advertised `client/harness.ts:1504`. Server edge: **not wired**, `server/harness.ts:699`. Native middle: **absent**. See §4 |

## Protocol / both directions

| Feature                                                          | Verdict                                                                       | Evidence                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Progress notifications (`progressToken`, progress/total/message) | **have** — bus-sourced, not a direct wire write                               | token ingest `projection/tools.ts:188`; ctx sink `server/harness.ts:862`; projection `projection/logging.ts:146`          |
| Cancellation (`notifications/cancelled`)                         | **partial** (defect) — `ctx.signal` is a dead controller                      | `server/harness.ts:855` and `:1224` — see §1                                                                              |
| `ping`                                                           | **have** (SDK-provided)                                                       | `testing/conformance.ts:775`                                                                                              |
| `_meta` general carriage                                         | **partial** — tools + resource contents yes, prompts no                       | `wire-extensions.ts:46` (one namespaced key, both directions)                                                             |
| Protocol version negotiation                                     | **have** (seam), **partial** (impl) — only the draft passthrough codec exists | `client/era-codec.ts:1`, `:34`                                                                                            |
| Capability negotiation                                           | **have**, and stricter than the spec requires                                 | `server/protocol/lifecycle.ts:57` — advertise-what-is-wired; `override = true` is a deliberate no-op `:47`                |
| Tasks (call→task, statuses, get/result/cancel/list, polling)     | **have**                                                                      | `projection/tasks.ts:221`; status fan-out `:155`; `interrupted` lossy-maps at the wire `:53`                              |
| `tasks/list` pagination                                          | **missing**                                                                   | `projection/tasks.ts:278` returns the full map                                                                            |
| Authorization — RFC 9728 discovery, OAuth step-up                | **have**                                                                      | `server/transports/http.ts:31`, `:37`; `server/security/www-authenticate.ts`                                              |
| Transports — stdio + Streamable HTTP, session management         | **have**                                                                      | `server/transports/http.ts:12`, session map `:351`, `Mcp-Session-Id` routing `:426`                                       |
| Resumability / redelivery (`Last-Event-ID`)                      | **missing** — no `eventStore` passed to the SDK transport                     | `server/transports/http.ts:466` — see §5                                                                                  |
| JSON-RPC batching                                                | **deliberately-not**                                                          | removed from the spec; zero implementation and zero rejection code in `packages/mcp/src` — correct posture, nothing to do |
| Icons metadata                                                   | **partial** — tools only                                                      | `projection/tools.ts:364`                                                                                                 |
| MCP Apps (`_meta` ui templates)                                  | **have** — carriage exists, both directions                                   | `wire-extensions.ts:80` documents the `openai/outputTemplate` → `ui://` case verbatim                                     |

---

## §1 — Cancellation and outbound content: two defects, not gaps

These are the only findings in this audit where the code is _wrong_ rather than
_absent_, and both are small.

**Cancellation does not reach handlers on the MCP server.** Both request-ctx
mint sites construct a throwaway controller:

```ts
signal: new AbortController().signal,   // server/harness.ts:855 and :1224
```

Nothing ever aborts it. The SDK already hands us exactly what is needed:
`RequestHandlerExtra.signal: AbortSignal`, documented as "an abort signal used to
communicate if the request was cancelled from the sender's side"
(`@modelcontextprotocol/sdk@1.29.0`, `dist/esm/shared/protocol.d.ts:175-177`).
Every `setRequestHandler` callback in the projection layer receives it and none
of them read it. So a client that cancels an in-flight
`tools/call` against an agentick MCP server gets its JSON-RPC request dropped
while the handler runs to completion — burning tokens, holding a sandbox,
finishing a write. Agentick's native AbortSignal spine is fine; the MCP boundary
just does not connect to it. **Build. S.**

**Outbound tool-result content is an unchecked cast.** `projection/tools.ts:278`
does `content: result.content as CallToolResult["content"]`, and the `CreatedTool`
wrapper normalizes only the result _currency_ — string vs array vs envelope —
never the block _types_ (`server/config.ts:975`). Agentick's `ContentBlock` union
has 23 members (`spec/src/data/content-blocks.ts:610`); MCP's has five. A tool
returning a `JsonBlock`, `CodeBlock`, `XmlBlock`, `VideoBlock`, or
`CustomContentBlock` — all first-class in this framework, all recommended by our
own docs — emits content no MCP client can parse.

The asymmetry is the tell: the **inbound** direction has a real mapper
(`integration/content-mapper.ts:87`, which even degrades `resource_link` to a
tagged text blob at `:130`). Outbound has nothing. The fix is the mirror of the
file that already exists, and "wire constraints live at the wire" says it belongs
in the projection, not in the substrate. **Build. S/M.**

## §2 — Prompt and resource metadata: the `metadata.mcp` convention stopped at tools

`PromptDeclaration.title` exists in spec (`prompts-harness.ts:154`) with a
doc-block explaining that it exists _precisely so a projected remote prompt keeps
its title_ — and `toWirePrompt` (`projection/prompts.ts:178`) emits only
`name` / `description` / `arguments`. The field is declared, documented,
motivated, and dropped on the floor.

Wider: `wire-extensions.ts` established exactly the right convention — one
namespaced `metadata.mcp` key, read/written by helper functions, projected at the
wire, byte-identical when absent, and folded on the inbound side too
(`wire-extensions.ts:23`). It was never extended to prompts or resources, both of
which already carry the open `metadata` bag it needs (`prompts-harness.ts:193`,
`resources-harness.ts:98`). So prompts get no `title`, no `icons`, no `_meta`;
resource descriptors get `title` but no `icons`, no `_meta`.

No new spec surface is required — the bags exist, the convention exists, the
helper shape exists. This is generalizing a pattern that already proved itself.
**Build. S.**

## §3 — Pagination: resources solved it, nothing else adopted it

MCP requires cursors on every list verb. Exactly one native harness has them, and
it has them _first-class_: `resources-harness.ts:159` is literally commented
`pagination first-class — MCP requires cursors`, with `cursor` on the input and
`nextCursor` on the result, threaded end to end through the projection
(`projection/resources.ts:102`) and out to the client harness
(`client/harness.ts:1113`).

Everything else returns a whole array: `ToolCatalog.list()` (`tool/src/catalog.ts:53`),
prompts, skills, completions, elicitation — no `cursor` token in any of their spec
files. The client harness mirrors the split exactly: `listResources` /
`listResourceTemplates` / `listPrompts` all accept a cursor and return
`nextCursor` (`client/harness.ts:1113`, `:1146`, `:1204`), while `listTools()`
takes no argument at all (`:873`).

**Steel-manning the null hypothesis.** Does this matter? For agentick's own
catalogs, honestly: mostly no. Tool lists are context-window-bound — a server
projecting 5,000 tools has a design problem pagination will not fix, and every
tool must fit the model's context anyway. The array-return is not obviously wrong
for the thing agentick actually is.

It fails in two concrete places, though. First, **as a client**: `listTools()`
having no cursor parameter means agentick silently consumes only the first page
of any large remote server — a correctness bug against third-party servers we do
not control, not a scaling preference. Second, **`resources` proves the cost is
low**: the substrate already permits it (`Store<T,Q,M>`'s `Q` is generic —
`spec/src/protocol/store.ts:62` explicitly lists "a cursor" as a legal query), so
this is per-harness work with zero foundational change.

Note the architectural inconsistency for the record: letting MCP's cursor
requirement into the _native_ resources seam sits in tension with "wire
constraints live at the wire." It was the right call — pagination is a genuine
storage concern, not an MCP quirk — but it means the principle is "wire
_encodings_ live at the wire", and pagination is not one.

**Verdict: build the client-side `listTools(cursor)` fix (S, correctness). Build
tools + prompts native cursors (M). Defer skills/completions/elicitation — no
consumer.**

**RESOLVED 2026-07-30 (pagination-consistency workstream).** The mechanism itself
was the first thing to fix: resources' hand-rolled `paginate()` moved to
`@agentick/utils` (`paginate(all, cursor, pageSize?)` + `DEFAULT_PAGE_SIZE`, opaque
decimal-offset cursors, garbage cursor ⇒ page one) and resources now imports it. On
top of that one helper: `listTools(cursor)` on the client harness returning
`McpToolPage`, with tool discovery draining every page (#250 closed); MCP server
`tools/list` and `prompts/list` honoring the request cursor and emitting
`nextCursor`; and native wire cursors on `prompts/list`, `skills/list`, and
`session/list_tools`, each returning an MCP-shaped envelope. Skills was included
rather than deferred — it is the same three-line change once the helper exists, and
leaving one native list unpaginated is the inconsistency the audit was about. The
LAW the work is built on: an in-process sync `list()` stays an unpaginated bounded
snapshot (the `Enumerable` contract), and pagination lives at the wire and at
projections. Completions and elicitation stay unpaginated — still no consumer.

## §4 — Sampling: the one real architectural question

The only feature where agentick lacks a native concept rather than a projection.

**State of play.** Client edge: an adopter may supply a raw `samplingHandler` and
we advertise the capability (`client/types.ts:186`, `client/harness.ts:1504`) —
but the types file says outright that routing sampling to agentick's own executor
"is a Wave 3 concern" (`client/types.ts:182`), so today the adopter hand-writes a
model call against SDK-typed params. Server edge: unwired, `sampling: false`
(`server/harness.ts:699`), with a named-but-unbuilt `SamplingHarness` and a
skipped conformance section (`testing/conformance.ts:887`). Native middle:
nothing.

**Documentation drift found:** `server/protocol/lifecycle.ts:80` claims `ctx.sample`
was "installed in #171d". It does not exist — that line is the only hit for
`ctx.sample` in the entire workspace. Delete or correct it.

**Steel-manning the null hypothesis — the outbound half.** Why would an agentick
MCP server ever ask its _client_ to run inference? It has a model. Models are
session-owned and tree-declared per tick (ADR 56); a server-side tool handler that
needs inference composes what already exists — `session.spawn()` with its own
model, or a nested app. Sampling adds no _capability_ there. What it transfers is
**cost and consent**: the caller's tokens, the caller's approval, the caller's
model. That is a real thing, but it is a billing-and-trust argument, and agentick
has no cross-boundary cost primitive to hang it on. Nothing else in the framework
is shaped that way.

Further: this is a bad fit for the "tool-is-the-action" line. Sampling is not an
action a caller invokes; it is a _reverse_ dependency where the callee reaches
back through the connection. Modeling it would mean a genuinely new inversion, and
the three-consumers rule finds one hypothetical consumer.

**Verdict for outbound (server→client sampling): defer.** The `SamplingHarness`
name should stay a TODO, not become a package. Revisit if a real adopter needs
caller-paid inference.

**The inbound half is different, and is the actual gap.** When agentick connects
to a third-party MCP server that legitimately wants sampling, the adopter must
hand-write a model invocation against raw SDK types — despite the session sitting
right there with a configured model executor. The composition is one adapter:
`createMessage` params → the session's model → result. That is not a subsystem;
it is a default handler over primitives that exist.

It must ship as **capability, not opinion**: answering a remote server's inference
request on the user's dime is a policy decision, so the mechanism is a default
handler behind an explicit opt-in with a `(request) => verdict` seam at the
decision point — the same shape as guards and gates, per "seam over setting".
Never on by default.

**Verdict for inbound: build, S/M, opt-in with a guard seam.**

## §5 — Resumability: one unset SDK option

`server/transports/http.ts:22` states "The SDK owns id generation + resumability"
— half right. The SDK _supports_ resumability, but only when constructed with an
`eventStore`, and `:466` passes only `sessionIdGenerator`, `onsessioninitialized`,
`onsessionclosed`, and `enableJsonResponse`. Without a store there is no
`Last-Event-ID` replay: a client whose SSE stream drops mid-stream silently loses
every notification sent while disconnected — progress, log messages, task status,
`list_changed`.

This matters more for agentick than for a typical MCP server precisely _because_
our tasks and progress projections are good: long-running Pattern B tasks are the
exact workload where a dropped stream loses the most. It is an interface
implementation plus wiring — no protocol design. **Build. M.**

## §6 — Deliberately-not

- **JSON-RPC batching.** Removed from the spec. Zero implementation, zero
  rejection scaffolding — the right amount of code for a withdrawn feature.
- **The 100-value completion cap in the primitives.** `@agentick/completions`
  builders return everything they find; only `clampToWireLimit`
  (`projection/completions.ts:87`) trims, so the same resolver over the agentick
  wire is uncapped. This is "wire constraints live at the wire" implemented
  exactly, and it is a _refusal_ to inherit v1's behavior — worth keeping labeled.
- **Advertising capabilities we cannot serve.** `buildCapabilities`
  (`server/protocol/lifecycle.ts:47`) makes adopter `override.X = true` a no-op
  when unwired. Stricter than MCP requires. Keep.
- **A roots harness.** Roots are read-only facts about the _peer_, scoped to one
  connection, with structural isolation rather than a filter
  (`server/projection/roots.ts:10`). ADR 65 records the upgrade trigger. Correctly
  refused a subsystem.
- **A typed dependency on `@modelcontextprotocol/ext-apps`.** MCP Apps support is
  the generic `_meta` carriage and nothing else — the package sits in the lock file
  only transitively and is declared by no agentick `package.json`. The `ui`
  descriptor rides the same open key as any other `_meta`
  (`wire-extensions.ts:80`), exercised end to end at
  `server/__tests__/tool-extensions-e2e.spec.ts:127` and through the loop executor
  at `loop-executor/src/__tests__/characterization.spec.ts:779`. Right call while
  the Apps direction is still moving — no vendored types to chase.

---

## The inverse — what agentick has that MCP has no vocabulary for

None of these project out over MCP, and that is almost entirely correct: MCP is
the _intersection_ protocol, and agentick's extras already reach an MCP client
through the three nouns MCP does have.

- **Skills** (`packages/skills/`) — composed prompt + resource + tool bundles with
  a run surface. No MCP equivalent. They already reach a client _as_ prompts and
  tools; a `skills` capability would be a dialect only agentick speaks.
- **Knobs** (`packages/knobs/`) — model-visible, model-settable reactive state.
  Already projects to the model as `set_knob`, a tool. Tool-is-the-action covers
  it exactly.
- **Gates / guards / hooks** — loop continuation and the proceed/veto/replace/defer
  verdict seam. These are _interior_ control-flow; exposing them across a trust
  boundary would let a caller steer our loop. Correctly absent.
- **Timeline / journal** — the conversation is a first-class, filterable,
  compactable structure. MCP has no conversation concept at all; it is stateless
  per request.
- **Live / subscriptions** — streaming and channel sync. MCP's notification set is
  fixed and closed.
- **Sandbox** — provider-backed scoped execution, reached through `ctx.sandbox` and
  tree-scoped tools. Reaches MCP clients as tools.

Two things worth saying about this asymmetry:

1. **The seam already exists if we ever want it.** `capabilities.extensions`
   (`server/protocol/lifecycle.ts:118`) is an open namespace merged verbatim,
   explicitly because the harness cannot verify an extension's surface. Any of the
   above could be advertised there without touching the closed capability set.
2. **Our own wire is generically better.** Agentick's gateway auto-projects _any_
   `exposure: "wire"` declared command through one dynamic lane
   (`gateway/src/dynamic-commands.ts:1`) across nine session surfaces (`:38`) —
   "new capability requires new DECLARATIONS, never new plumbing" (`:11`). The MCP
   side, by contrast, needs a hand-written projection module per feature. That is
   MCP's constraint, not our design failure, but it explains why parity work here
   is always per-feature labor.

## Corrections to things we believed

- **The recorded "MCP server-harness next.5 gaps" are ALL closed — the note is
  stale and should be rewritten.** It listed five limits hit porting Knowify's MCP
  server: declaration `_meta` and result `_meta` dropped (the MCP Apps and
  `www_authenticate` step-up cases), no annotation hints, ctx-free prompt
  render/completion, identity-free resource resolvers. Every one now lands.
  Declaration and result `_meta` both project through the one namespaced key
  (`wire-extensions.ts:78`/`:95`, wired at `projection/tools.ts:369` and `:286`);
  annotation hints project (`wire-extensions.ts:67` → `projection/tools.ts:372`);
  and prompt render, prompt-argument completion, and resource resolution all now
  run on the crossing's fiber carrying the caller's identity plus the `mcp`
  boundary facet with its live credential (`projection/prompts.ts:117`,
  `projection/completions.ts:233`, `projection/resources.ts:146`). The ADR 91/92
  crossing work closed four of the five as a side effect.
- **`ctx.sample` does not exist** despite `server/protocol/lifecycle.ts:80` saying
  it was installed.
- **Effect-returning tool handlers are unsupported on the MCP server projection**
  (`server/config.ts:993`) — a throw, not a silent failure, but worth knowing.

---

## Shortlist — what is actually worth building

Ordered by earn-per-line. Nothing here is a new vertical; the framework squares
up with MCP far better than the folklore suggested.

1. **Thread the SDK's per-request abort into `ctx.signal`.** — Earns: client
   cancellation actually stops server-side work instead of orphaning it. **S**
2. **Outbound content-block mapper (agentick `ContentBlock` → MCP content
   union).** — Earns: tools returning json/code/xml/video blocks stop emitting
   content MCP clients cannot parse; mirrors the inbound mapper that already
   exists. **S/M**
3. **Extend the `metadata.mcp` convention to prompts and resources, and project
   `PromptDeclaration.title`.** — Earns: the declared-and-dropped title reaches
   the wire, and prompts/resources get the icons + `_meta` (MCP Apps) carriage
   tools already have, with no new spec surface. **S**
4. **`listTools(cursor)` on the client harness.** — Earns: stops silently
   truncating the tool list of any large third-party server. **S**
5. **Inbound sampling default: answer `sampling/createMessage` from the session's
   own model, opt-in, behind a verdict seam.** — Earns: removes the hand-written
   model call an adopter needs today, without making caller-paid inference a
   default. **S/M**
6. **Native cursors on tools + prompts list, and an `eventStore` for HTTP
   resumability.** — Earns: full pagination parity, and SSE reconnect stops
   losing task-status and progress notifications on long-running work. **M**

Explicitly **not** on the list: a `SamplingHarness` for server→client sampling
(defer — no consumer, and it needs a cost primitive we do not have), a
`RootsHarness` (ADR 65 already refused it with a recorded trigger), batching
(withdrawn from the spec), and any projection of skills / knobs / gates / timeline
as MCP capabilities (they already reach clients through tools and prompts).

---

## Addendum — issues filed from this audit (2026-07-30)

The audit's fan-out (three background sweeps: sampling/roots/outward
projection, pagination, protocol features) surfaced concrete defects that were
filed immediately rather than left in prose. The shortlist ↔ tracker mapping:

| Shortlist | Issue | Title                                                                                              |
| --------- | ----- | -------------------------------------------------------------------------------------------------- |
| #1        | #254  | MCP server `ctx.signal` is a throwaway — SDK per-request abort never threaded                      |
| #2        | #255  | Outbound tool-result content is an unchecked cast onto MCP's 5-member union                        |
| #3 (half) | #253  | MCP server prompts projection drops `title` (and prompt/result `_meta`)                            |
| #4        | #250  | MCP client `listTools()` ignores pagination — page-two tools silently lost — **CLOSED 2026-07-30** |
| —         | #251  | `session/abort` wire verb is a no-op stub (native wire, found en route)                            |
| —         | #252  | `initialize` advertises a hardcoded capability bag — `cursorResume: true` is                       |
|           |       | false; version never validated; `serverInfo` wrong (native wire)                                   |

Shortlist #5 (inbound sampling default) and #6 (native cursors + `eventStore`)
are design-first items — file on pickup, not before.

From the native sweeps, two structural facts the tables above do not carry:

- **Pagination has no generic seam to retrofit.** `CollectionStore.list()`
  returns a bare `readonly T[]` (nowhere for a continuation token), and the
  client `Enumerable` contract ("`list()` is a bounded synchronous snapshot")
  is a second independent obstacle. Resources hand-rolled `paginate()` above
  its store; anything else will too, until a paged result envelope is a
  deliberate store-seam decision. The LOG profile is already fully cursored —
  different archetype, not reusable here.
- **The `added`/`removed` topology notifications from the
  enumeration-is-foundational principle were never built as discrete
  payloads** — change fan-out is uniformly payload-free ping + re-read. That
  works, and it is also why cursor-paging a client handle is structurally
  awkward: a paged `list()` cannot be a "current state" snapshot.
