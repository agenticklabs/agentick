# v2 README & Website — positioning + narrative design

**Status: draft** — the pre-read for the positioning workshop. Every API name
in this document was verified against `feat/v2` source (2026-07-24 sweep;
citations inline). Decisions pinned here render into `README.md` first, the
website second — one voice, two surfaces.

Open workshop items (Ryan brings reference sites) are in §7. Everything else
is proposed and ready to render.

---

## 1. Positioning

### Category line (settled register, exact wording open)

> **agentick is a framework for engineering agent harnesses — the context,
> the loop, and the wire.** Not a harness: the thing you build harnesses with.

"Harness" is the category noun but is _earned by the second scroll_, never
the first sentence — outside this repo it either means nothing or means "the
loop around the model." The headline is a capability claim; the category line
sits directly under it.

### Headline candidates (pick one at the workshop)

1. _Agents where you own every token and every loop._
2. _The context window is a data structure. The loop is yours. The wire is open._
3. _Engineer the context. Drive the loop. Serve the wire._
4. Current README's "The component framework for AI." — **retire**: it
   over-claims React-centrality (the compiler is not React) and says nothing
   about the headless/wire half.

### The thesis (one sentence, everything hangs off it)

> **Every surface the model can touch, code can touch — in process or over
> the wire.**

Adjacent frameworks cannot make this claim because they have no protocol
seam; they have an object with methods. We have: the same `TimelineHandle` /
`GatesHandle` / `TasksHarnessProtocol` the loop uses, exposed to host code
(`session.*`), projected over a typed wire (`WireMethods`), and — where the
concept maps — served as native MCP.

### Voice

- **Humble in claims, precise in mechanics.** No superlatives, no "best way
  to build agents." The register: "an evolving approach; here is exactly
  what it does; here is what it doesn't do yet."
- **Receipts over adjectives.** Capabilities link their conformance suites.
  A visible **Status & known gaps** section is the humility mechanism —
  not softened language. Vercel-mode layout, monk-mode claims.
- **Code speaks — and therefore code must be true.** See §8 (code-compiles
  law). A hero showing an API that doesn't exist is the one dishonesty this
  README cannot afford.
- **De-weight knobs.** No knob in the hero, no dedicated knobs section.
  Knobs appear as one row in the harness catalog and inside the gates story
  (gate values are knob-backed). Gates appear _inside_ the control story,
  not as the headline — a continuation predicate is a supporting actor.

---

## 2. Hero — one session, three drivers

One agent definition, then the same session driven three ways. This is the
three-pane (or three-beat scrolling) hero for both README and site.

### Pane 1 — author it (the context is a tree you control)

~15 lines of JSX: `<System>`, one real tool, `<Timeline>` with a render
function (the compaction tease), a verified gate. **No knobs.** Draw the
final snippet from `example/v2-real/src/agent.tsx` and keep them in lockstep.

### Pane 2 — drive it headless (no model in sight)

All verified real (`packages-next/session/src/harness.ts`):

```ts
const session = await app.createSession();

// Call any tool directly — no model, no loop. Works on a session
// constructed without a model executor at all.
const blocks = await session.dispatch("deploy_preview", { branch: "feat/v2" });

// The conversation is data: read it, append to it, subscribe, compact.
const history = session.timeline.history();
await session.timeline.compact(strategy);

// Flip a gate while a send is in flight — next tick sees it.
session.gate("verify")?.clear();

// Spawn managed background work from host code.
const task = await session.tasks.submit(work, { title: "reindex docs" });
await session.tasks.result(task.id);

// Swap the model between sends — journaled, hookable.
await session.model.setModel("anthropic/claude-fable-5");
```

Supporting cast available for docs (not all in hero): `session.spawn()`
(subagent graph, depth-capped, parent-owned teardown — `harness.ts:1395`),
`session.state`, `session.knob(name)`, `session.use/guard/hook`,
`session.snapshot()/restore()`.

### Pane 3 — serve it (the wire is open, and it speaks MCP)

Two beats:

1. **Gateway + client.** `createGateway` over any of five transports (http,
   websocket, unix-socket, in-process, embedded fetch handler); the client's
   sub-handles (`session.tasks/knobs/elicitations/timeline` in
   `@agentick/client-next`) drive the same surfaces remotely
   (`session/send`, `session/dispatch`, `session/timeline_history`,
   `sub/subscribe`, `knobs/set`, `tasks/cancel`, `timeline/compact`,
   `prompts/invoke`, …). Embedded mode: `fetchServerTransport` mounts a
   web-standard `(req) => Response` handler in Hono/Next/Bun/Express-via-
   adapter — tested (`embedded-fetch-handler.spec.ts`).
2. **Native MCP, both directions.** Mount external servers with
   `withMCP({ servers })` (per-session isolation, reactive re-discovery —
   tested e2e). Serve _as_ an MCP server with `spawnStandaloneMcpServer` —
   tools, prompts, resources, tasks, elicitation, logging, completions,
   progress, roots, each with its own spec suite. The alignment is
   structural, not adapted: `McpLogLevel` is a **type alias** of the
   framework's `LogLevel` (RFC-5424 identity, `spec/src/protocol/`
   `mcp-server-harness.ts:77`), progress tokens share the wire type, method
   naming/`_meta`/`initialize` mirror MCP conventions by design.

---

## 3. The scroll — section beats after the hero

Ordered; each beat names its verified anchor.

1. **Only what you render reaches the model** (kept from current README —
   it's the strongest line we have). `<Timeline>` render-function shaping,
   sections, semantic components.
2. **The compiled context is data.** `RenderedTree` — JSON-shaped IR, spec
   firewall against live refs. Three honest touchpoints: standalone
   `compileTemplate(element)` → `{ tree, diagnostics }`; the harness's
   `renderTree()`; and `executor.project({ compiled, target, tools })` →
   the exact provider-agnostic `LanguageModelInput` — **which accepts a
   hand-built tree with no React anywhere** (`spec/src/protocol/executor.ts:101`).
   Plus the provenance sidecar (which layer contributed each entry, ADR 63).
   This beat is how we say "the compiler is not React; React is one
   authoring frontend" _truthfully today_ — the functional frontend (ADR 44)
   stays in Status & gaps until built.
3. **Context engineering, not context hoping.** Append-only timeline log +
   projection split; `timeline.compact(strategy)` rewrites the projection
   only, the log stays as ground truth, `lastCompaction` provenance
   recorded (conformance-tested). Cache hints: `<Section cache>` /
   `<Message cache>` → provider mechanics (Anthropic `cache_control` with
   TTL — per-surface tests exist). **Gated sentence:** "a stable prefix by
   construction" may not print until the prefix-stability test lands (§5).
4. **The loop is a policy surface.** Ticks; `shouldContinue` folding;
   verified gates are level-triggered and fail-closed; host `clear()` /
   `defer()` / `override()` land on the next tick's decision; steering
   (`onBusy: "steer" | "queue"`); `maxTicks`; abort. Gates get their
   moment here — _as the demonstration of external control of a running
   loop_, not as the thesis.
5. **The graph.** `session.spawn()` (child sessions, send-through or
   handle-back, depth cap) + `session.tasks` (submit/observe/await/cancel
   from host code). Honest term: a spawn _tree_ with task fan-out — don't
   say "arbitrary DAG."
6. **The harness catalog.** The table, one row per harness, uniform
   pattern; the ADR-27 sentence ("built-ins are bundled, not privileged")
   spelled out — this is genuinely interesting to the target reader.
   Knobs live here, one row.
7. **Status & known gaps.** See §5 "do not print" — that list, published.
   This section is load-bearing for credibility, not an appendix.

---

## 4. What the current README gets wrong (delta list)

- Knobs in the hero, in "The idea," _and_ a dedicated section — while the
  headless/wire half of the framework is absent entirely (gateway/client/
  mcp appear only as table rows). The rewrite adds the missing half and
  demotes knobs; it is not a re-weighting of existing sections.
- "The component framework for AI" + "A React reconciler whose render
  target is a language model" — frames React as the framework rather than
  a frontend. Replace per §1/§3-beat-2.
- No mention of: dispatch-without-model, tasks-from-host, gate override,
  timeline compaction, snapshot/restore, spawn, MCP serving, embedded
  gateway, `RenderedTree`, `executor.project`.

---

## 5. Claims ledger

### Print freely (verified, cite the suite)

- Headless drive: `session.dispatch` (model-less, returns `ContentBlock[]`),
  `session.timeline` read/append/subscribe/compact, `session.gates` /
  `session.gate(name)` clear/defer/override mid-flight, `session.tasks`
  submit/list/result/cancel, `session.spawn`, `session.model.setModel`,
  `session.snapshot/restore`, `session.use/guard/hook`.
- Wire: 5 transports (all with transport-conformance suites), embedded
  fetch gateway, client sub-handles, `sub/subscribe` event stream,
  dynamic-command lane (`<ns>/commands`).
- MCP: `withMCP` mounting (e2e-tested); standalone serving of
  tools/prompts/resources/tasks/elicitation/logging/completions/progress/
  roots (per-primitive spec suites); RFC-5424 LogLevel identity.
- Compiler: `RenderedTree` as data; `compileTemplate`; `executor.project`
  on a hand-built tree; provenance sidecar; stable section ids across
  recompiles (`collect.spec.tsx`).
- Compaction: projection-only rewrite, log preserved, provenance
  (`timeline/src/conformance.ts`).
- Resources: the model discovers and reads resources through shipped
  `resource_list` / `resource_read` tools, default-on via `withResources()`
  (opt-out `registerModelTools: false` — `resources/src/extension.ts:61`);
  RFC-6570-lite URI templates; and **remote MCP resources proxy-register
  into the same session registry** (`mcp://<alias>/…`,
  `mcp/src/integration/resource-surface.ts`) — one catalog, three feeders
  (local, JSX `<Resource>`, remote MCP), re-discovered on `list_changed`.
- Structured output at the model tier: `generateObject()` — Standard
  Schema → canonical `responseFormat` → adapter-translated → validated
  typed value (`model/src/generate-object.ts`). Caveat in copy: Anthropic
  adapter's translation is a marked TODO (tool-shaped strategy).
- **Tool-call narration** — the projector injects a reserved optional
  `_summary` field into every model-facing tool schema so the model
  self-narrates each call in one first-person sentence ("Searching the
  docs for retry config"); the tool executor strips it before validation
  so handlers and persisted results never see it
  (`TOOL_NARRATION_FIELD`, `spec/src/data/declarations.ts:485`). Surfaces
  to hosts/UIs via `ToolPresentation` — identity (`name`/`title`) and
  activity (`summary`/`narration`) as four distinct fields, precedence
  deliberately left to the client. Default ON; app-level off-switch
  (`createApp({ narrate })` — the token-cost knob) + per-tool
  `ToolAnnotations.narrate: false`. Tested: `narration-injection.spec.ts`
  (model) + `narration-strip.spec.ts` (tool-executor). Story home: the
  "serve it" beat — live spinners in every client for free — and a
  README one-liner in the loop beat.

### Blocked on a test (write the test, then the sentence)

- **"Cache-friendly by construction" / stable prefix across ticks.** All
  mechanics exist (no-reorder contract on the IR, append-only log,
  `cache_control` stamping tested) but no test renders two ticks and
  asserts the projected prefix is byte-identical. Land
  `prefix-stability.spec` (compiler-react or model-executor) first.

### Do not print (absent or stubbed)

- **"Run a skill."** `SkillsHandle` = get/list/search/register/update/
  remove/resolve/require — a durable library, **no run verb**. Copy says
  "manage and resolve skills from host code / over the wire." (Feature
  decision open — §6.)
- **`session.hooks` / `session.skills` as universal members.** Real
  spellings: `session.hook()/use()/guard()`; `session.skills` and
  `session.prompts` exist only with `withSkills()` / `withPrompts()`
  installed (auto-namespace getters, `harness.ts:805`).
- **Functional (non-JSX) authoring** — ADR 44 is Draft; no `agent()` export
  exists. Belongs in Status & gaps as direction, not capability.
- **MCP sampling** (hardcoded `sampling: false`), **`asClient()`**
  in-process projection (throws, #171g), **gateway-hosted MCP serving**
  (Mode B slot declared, gateway never populates it — only standalone
  Mode A serves today).
- **Gates over the wire.** No `gates/*` namespace; remotely you can only
  flip the backing knob via `knobs/set`. Don't imply remote
  `override()/defer()`.
- Named compaction strategies (`rollingSummary`, `slidingWindow`) —
  deferred; only `fromHandler` escape hatch ships.

---

## 6. Feature gaps the story surfaced (build vs write-around)

The narrative sweep doubles as a product gap list. Status per item
(2026-07-24):

1. **`skills.run(name, { args, output })` — DESIGN PROPOSED.** A skill
   stays non-executable data (the line holds: skills guide agent work);
   "running" one is sugar over existing primitives: `skills.resolve(name)`
   → a send primed with the skill body + args → structured final turn →
   validated typed result. The model is the executor. Prerequisite is
   already a named trailhead: `TODO(trail-response-format-send)` — surface
   `responseFormat` on the session tier's `SendInput`
   (`model/src/generate-object.ts` docblock); `generateObject()` supplies
   the schema→parse machinery. Bonus alignment: the Agent Skills
   `allowed-tools` frontmatter maps onto `SendInput.tools` (exists).
   Open sub-decision: default execution site — ephemeral `session.spawn`
   child (clean parent timeline, result-only) vs inline send (skill work
   becomes conversation); recommend isolated-by-default with an option.
2. **`gates/*` wire namespace — DECIDED YES (Ryan, 2026-07-24).** Declare
   `clear`/`override`/`defer` commands with `exposure: "wire"` on the
   gates harness + add `gates` to `SESSION_SURFACES`
   (`gateway/src/dynamic-commands.ts:38`). Same audit trail as host-side;
   wire origin identity already threads via `inbox.ask(..., origin:
"wire")`.
3. **`resources` missing from `SESSION_SURFACES` — latent gap, fix with
   #2.** The harness already declares `resources:read/list/listTemplates`
   with `exposure: "wire"` (`resources/src/harness.ts:260`), but the
   gateway dynamic-command lane never routes them — declared-but-
   unreachable. One-line + tests, ride the gates change.
4. **Prefix-stability test** — cheap, unblocks the strongest sentence in
   the context-engineering beat.
5. **Mode B (gateway-hosted MCP)** — `createGateway({ mcpServers })`; slot
   already declared. Needed before the website says "serve MCP from your
   gateway"; standalone-only until then.
6. **Enumeration gap** — no `collections/*` wire surface; per the
   enumeration-is-foundational rule, check each projected collection ships
   `enumerate` + topology notifications before the client docs promise
   "discover everything at boot."
7. **Per-harness model tools — CONVENTION, not a bridge (separate
   thread).** The pattern already exists three times, all hand-authored
   thin front-ends forwarding to their harness: `set_knob` (mounted by
   `<Knobs/>`, forwards to the `knobs:dispatch` command),
   `resource_list`/`resource_read` (`withResources`, default-on,
   `registerModelTools` opt-out), `session_tasks_*`. Codify in the ADR-27
   per-harness layout: each harness MAY ship `src/tools.ts` (model-facing
   tools for the actions that make sense) behind a uniform
   `registerModelTools`-style option. Explicitly REJECT an automatic
   command→tool bridge: the axes are deliberately orthogonal
   (`CommandExposure = internal|addressable|wire` is reachability;
   `ToolExposure = model|dispatch|runtime` is audience), and the three
   existing tools each do bespoke model-facing work a mechanical bridge
   gets wrong — model-directed naming/descriptions, input reshaping,
   honest degradation when the harness is unmounted. Curation is the
   point; the command's Standard Schema can still be _reused_ by the
   hand-authored tool (as `set_knob` reuses `knobs.dispatch` validation).
   Candidate sweep: skills (`skill_list`/`skill_read` — progressive
   disclosure), timeline (`compact`?), prompts, state. The story-level
   payoff for §1: **every harness projects to three audiences — host
   handles, wire commands, and (opt-in) model tools — the same capability,
   three drivers.**

---

## 7. Workshop agenda (open, Ryan brings references)

1. Pick the headline (§1 candidates) against 2–3 reference sites
   (Vercel/tRPC/Effect/TanStack genre).
2. Visual tokens: palette, type pairing, layout system — for the website;
   README inherits tone only.
3. Website IA: nav collapse (drop the v1/v2 split), which of the 31 v1 docs
   pages port vs die, `api/` regen (drops phantom reconciler dirs).
4. Hero form: three panes side-by-side vs three scroll beats; whether pane
   3 shows gateway+client or MCP first.
5. Ratify §6 item 1's open sub-decision (skill-run execution site) and
   the §6 item 7 convention — they change copy.

## 8. Code-compiles law

Every snippet in README/website is either (a) an excerpt of
`example/v2-real/src/` or (b) a file under a `docs-snippets/` workspace
compiled in CI. No freehand code in marketing surfaces. A snippet that
can't compile is a claim that can't be verified.
