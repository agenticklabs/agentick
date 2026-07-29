# Handoff — Ernesto client / UI track

Written 2026-07-29 at the end of a long session, to pick up after a compaction.
Two repos: `~/Documents/agentick` (framework, branch `feat/v2`) and
`~/Documents/work/knowify/nx-knowify` (consumer, branch `assistant-agentick-v2`).

## Do this first

1. **Publish `next.43`.** `next.42` is installed; the `"Done"` fix landed after it
   (`7e2bc178`) and is the one still costing the model retries. The flow:
   bump `packages/*/package.json` → `pnpm publish-dev` → in nx-knowify bump the 42
   pins in `libs/{ernesto-v2,mcp-v2,ernesto-client}` + `apps/assistant-api` →
   `pnpm install` → **`npx nx build ernesto-v2`** (assistant-api loads the BUILT lib,
   so a source edit alone never appears) → restart assistant-api.
2. **Ryan commits his in-flight work.** Four+ files in nx-knowify have his edits
   interleaved with mine in the same hunks, which is why several of my commits were
   staged hunk-by-hunk and do not build standalone. One commit on his side removes
   that friction permanently.

## Open work, in the order agreed

1. **Sticky user message** — asked for three times, still unbuilt. Must go in
   `apps/knowify-app/.../k-assistant-v2/chat/assistant-chat.component.ts`, which is
   what v3 actually renders — NOT `libs/ui`'s `k-chat-container` (v3 never mounts it;
   `stickyUserMessages` and `space-below` live there and are unreachable). Use v1's
   treatment: `position: sticky` + `max-height: 88px` + `overflow-y: auto`, so a long
   user message scrolls instead of eating the viewport.
2. **The two-fold property test.** The streaming fold (`foldStreamingTurn`) and the
   committed fold (`foldTimeline`) have now disagreed TWICE — `action` vs `internal`,
   then per-entry vs per-execution segmentation. They are meant to agree and nothing
   enforces it. One property test — "both produce the same row shapes for one turn" —
   would have caught both.
3. **Reactions / feedback.** Shape settled: a message entry with `role: "event"`
   (`SessionMessageRole` is an open union; `TimelineEntry` has only `message` and
   `boundary` kinds — there is no `kind: "event"`). `timeline.append()` verified NOT
   to trigger a run. The work is the FOLD projecting a reaction onto the row it
   references — append-only means it points backwards — plus the affordance.
   `foldTimeline` currently discards `role: "event"` entries.
4. **Empty "New conversation" screen** — two-step: agent roster from
   `client.gateway().listApps()` (returns `AppInfo` with `title`/`description` now),
   then curated suggested prompts per agent. Open question Ryan should answer:
   suggestions belong on the **app** (a `suggestions` field beside `title`, so a new
   agent ships its own and the client stays generic) vs curated in `ernesto-client`.
   My recommendation: on the app.
5. **Sub-agents as apps.** `apps/assistant-api/src/app/agents` has 19 v1
   `@Agent({ id, description, model })` — that IS `appId`/`description`/`model`.
   Ernesto is the orchestrator; specialists are directly chattable, which is what
   forced app-level identity. Delegation should be a TOOL that opens a session on the
   target app (spawn keeps the child inside Ernesto's app, so attribution collapses).
   Consequence: a sub-agent's work is its own session → rendering it nested is
   cross-session → **this is what makes the firehose necessary rather than nice.**
6. **The firehose.** `client.gateway().events(query, fromCursor)` already exists. Real
   motivation is cross-session liveness (thread list, task status), NOT `events()`
   termination — that already works, proven by
   `packages/transport-in-process/src/__tests__/progress-completion-e2e.spec.ts`
   (4 tests, full stack). **Scope by principal, not tenant** — "that's how the bus
   works" is an implementation fact, not an authorization decision.
7. **Full duplex** — a cheap classifier deciding whether to wake the expensive model.
   Ryan deferred it explicitly. Note the session currently SERIALIZES executions (a
   send mid-execution queues until quiescence), so this breaks a real invariant and
   wants an ADR, not a patch.
8. **Memory** — stays OUT of the framework (agreed). `libs/knowledge` becomes a
   `Store<T,Q,M>` adapter, not a new interface. The "whiffs" design is validated:
   embed the user's message fragments, search eagerly, render hints as a `<Section>`
   positioned AFTER the last user message. There is **no `<Ephemeral>` component**
   despite CLAUDE.md listing one, and `SendInput`'s `ephemeral` hatch is deferred — a
   `<Section>` is already non-persisted, so single-tick lifetime is the default.
   Tail placement is what keeps the cache prefix intact (~97% cached today).
   **Caution:** `episodic-memory.service.ts` decides cross-tenant shareability from an
   LLM-written `applicability` string. Derive it structurally; treat the model's
   suggestion as downgrade-only.

## Known-open bugs / gaps

- **The dot showing amber** is honest: `conversation.status()` folds wire AND session,
  and `ready()` is `view() !== undefined`. Amber = socket open, no session. If it
  persists, the question is why `open()` produced no view — not the dot.
- **`TransformStream` polyfill** is in `apps/knowify-app/app/src/test-setup.ts`. Fixed
  a suite that had never LOADED; that recovery immediately caught a stale assertion
  from my own `action` change.
- **`chat-input.file-handling.spec.ts` "extracts files from paste"** fails and is
  PRE-EXISTING — verified by stashing. Do not chase it as a regression.
- **`libs/ui` has 13 failures** in `activity-feed` / `report-viewer`, also
  pre-existing, same verification.
- **`render_table` duplicate announcement** is structural, not a bug: tool calls
  always continue the loop, so the model must emit something after the render tool.
  The real fix is to mark render tools **terminal** — agentick already has
  `terminalCapture` and the loop's DECIDE short-circuits on it before the
  continue-disposition is read. That is the mechanism; nobody has used it yet.
- **`pnpm.overrides`** (11 pins) is silently ignored by this pnpm version; belongs in
  `pnpm-workspace.yaml`.
- **`.gitignore`** in nx-knowify had `libs/**/[!typings]*.d.ts` — a CHARACTER class
  negating t,y,p,i,n,g,s, so 22 emitted `.d.ts` escaped it. Fixed, uncommitted.
- **v1/v2 package collisions.** `@agentick/mcp` is aliased to `@agentick/mcp-v1`;
  `@agentick/shared` and `@agentick/core` are the same disease and Ryan said he would
  alias them himself. Scope the sweep off DECLARED deps, not undeclared ones — that
  mistake cost a second runtime failure.

## Standing rules learned the hard way this session

- **Stage explicit paths, never `git add -A`.** Ryan's work is interleaved; I swept it
  once and had to reset five commits.
- **commitlint caps body lines at 100 chars.** Wrap, or the commit fails after the
  hooks run.
- **`nx build <lib>` after editing a lib** consumed via `main: ./dist`. Cost one
  round trip on the app title.
- **Never trust a docblock over the code.** Two were stale today: the `events()`
  WART (fixed long ago, still warning) and "no stream event carries `presentation`"
  (it does).
- **Run the gate from the repo root**: `npx vitest run` + `pnpm typecheck`. A
  per-package `--filter test` is a turbo no-op.
