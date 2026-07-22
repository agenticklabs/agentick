# One-Shot Prompt — "Build a codex-style dashboard on `@agentick/client`"

> **What this is.** A single, self-contained prompt you hand to an autonomous
> coding agent. It instructs the agent to build a complete, working, codex-style
> web dashboard on agentick's **real** client APIs — discovering the surface by
> reading the installed type declarations, verifying as it goes, and testing
> against the framework's **fake** model executor so it never spends provider
> tokens.
>
> **Why it exists (B1, the validation pivot).** This is the Ernesto-class
> validation demo. Every place the prompt has to *hedge*, warn about a name, or
> route around a missing capability is a discovered ergonomics defect. Those are
> collected in the sibling [`one-shot-friction-log.md`](./one-shot-friction-log.md),
> which becomes the B2 work list.
>
> The prompt below is grounded against the `feat/v2` tree as of this writing
> (packages under `packages-next/`, published names ending `-next`). The exact
> API names, signatures, and event kinds cited were read from source; the agent
> is nonetheless instructed to **re-verify against the installed `.d.ts`** before
> writing code, because names move.

---

## THE PROMPT

You are an autonomous software engineer. Your task is to build a **complete,
running web dashboard** — a codex-style agent console — on top of the
`@agentick/client` package. Not a plan. Not a mockup. Not a stub with `TODO`s.
A dashboard that connects to a live agentick gateway, creates and resumes
sessions, streams a model run token-by-token with thinking and tool activity,
handles human-in-the-loop confirmations, and exposes runtime controls — and that
you have **run and verified end-to-end** before you report done.

### Operating rules (read these first — they override your defaults)

1. **Do not stop at a plan or a mockup.** A design document is not the
   deliverable. A screenshot of an empty shell is not the deliverable. The
   deliverable is a dashboard you have started, driven, and watched work. If you
   find yourself writing "next, you would…" — stop and actually do it.
2. **Verify the real environment before you write a line of feature code.** You
   do not know the API from memory and you must not guess it. See
   *§1 Verify the environment* — it is a hard gate.
3. **Never invent an API name.** If you cannot find a symbol in the installed
   type declarations, it does not exist. Do not write it. Find the real one or
   route around the gap and log it.
4. **Verify by running, at every milestone.** After each feature, exercise it —
   drive the flow, watch the events, read the DOM. Tests and typecheck are
   necessary but not sufficient; you must observe behavior.
5. **Keep a running FRICTION LOG.** Every time you have to hedge, work around a
   missing capability, warn a future reader about a confusing name, or write
   glue the framework should have shipped — write it down (friction → severity →
   suggested fix). Deliver this log alongside the code. It is a first-class
   output, not an afterthought.
6. **Do not spend model tokens by default.** The whole build and its tests run
   against the framework's **fake** model. A real provider key is opt-in, gated
   behind an env var, and used only for a final smoke check if the user asks.

### Fixed stack (do not deviate)

- **Runtime:** Node ≥ 22 (the HTTP transport relies on global `fetch`).
- **Language:** TypeScript, strict, ESM (`"type": "module"`).
- **Server:** a small Node process hosting an agentick **gateway** with an
  HTTP server transport.
- **Client build:** **Vite** + **React 18** (function components, hooks).
- **Tests:** **vitest**.
- **No extra state libraries.** Bind agentick's live views straight into React
  with `useSyncExternalStore`. No Redux, no Zustand, no React Query.
- **No CSS framework required** — hand-rolled CSS is fine; responsive is a
  requirement (see the spec), not the styling engine.

---

### §1. Verify the environment (hard gate — do this first)

Before writing feature code, prove to yourself what you're building against:

1. **Confirm the installed packages and versions.** Read `node_modules` /
   `package.json`. Record the resolved version of `@agentick/client`
   (or `@agentick/client-next` on the pre-cut tree), the HTTP transport package,
   and the harness `/client` subpaths. Pin them. If a package is missing,
   install it — do not substitute a different one.
2. **Read the type declarations — do not assume names.** Open the `.d.ts` for:
   - the client bundle entry (`createClient`, `Client`, the session handle);
   - the HTTP client transport (the `http(...)` factory + its options);
   - the timeline `/client` subpath (`timelineView` + its options and the
     returned view shape);
   - the elicitation, tool-executor, and knobs `/client` subpaths (the members
     they contribute to the session handle);
   - the stream event union yielded by the send handle's `events()`.
   Write down the **exact** exported names and signatures you will call. When a
   doc comment and the actual export disagree, **trust the export** and log the
   drift.
3. **Stand up the smallest possible server and prove a round trip** — a gateway
   with the fake model, one trivial send, printed result — *before* building any
   UI. If this doesn't work, nothing downstream will.
4. **Only then** build the dashboard.

> Naming note for the agent: on the pre-v2.0-cut tree the published names carry a
> `-next` suffix (`@agentick/client-next`, `@agentick/transport-http-next`,
> `@agentick/timeline-next/client`, …). At the cut they drop it
> (`@agentick/client`, `@agentick/transport-http`, `@agentick/timeline/client`).
> Read what's installed; use those names.

---

### §2. The server (backend) — what to build

A single Node entrypoint that:

1. Constructs a gateway with an HTTP server transport bound to a port:
   ```ts
   import { createGateway } from "@agentick/gateway-next";
   import { httpServerTransport } from "@agentick/transport-http-next";
   import { reactCompiler } from "@agentick/compiler-react-next";
   import { scriptedAdapter } from "@agentick/model-next/testing";
   import React from "react";
   import { Agent } from "./agent.js";

   const gateway = await createGateway({
     transports: [
       httpServerTransport({
         port: 8787,
         // host defaults to 127.0.0.1 (loopback) — that is the security
         // boundary; leave it unless you deliberately expose the server.
         // The Vite dev server runs on a DIFFERENT ORIGIN (localhost:5173),
         // which is cross-origin to :8787 — you MUST allowlist it or every
         // browser request is rejected by the safe-by-default web-security
         // policy. In production, serve the built client from the SAME origin
         // and drop this.
         allowedOrigins: ["http://localhost:5173"],
       }),
     ],
   });
   await gateway.listen();

   const app = await gateway.createApp({
     appId: "dashboard",
     rootElement: React.createElement(Agent),
     options: { model: scriptedAdapter("..."), compiler: reactCompiler() },
   });
   ```
2. Defines a small JSX `<Agent/>` with:
   - a `<Timeline/>` so the conversation renders into model context;
   - at least two **knobs** (`useKnob`) the model or the client can flip — a
     boolean and a numeric/enum one — so the controls panel has something real
     to drive;
   - at least one **elicitation-gated** tool (a "write" tool that calls
     `ctx.elicit.confirm(...)`), so the client sees a human-in-the-loop request;
   - at least one long-running **task** tool (`ctx.tasks.submit(...)`), so the
     client can render live task status;
   - at least one tool that emits `ctx.log(...)` diagnostics.
3. **Model wiring for testing:** the default model is
   `scriptedAdapter("<canned reply>", { chunks: [...], thinkTags: true })` from
   `@agentick/model-next/testing` — this is the no-token path. Gate a real
   provider (`aisdk(openai(...))`) behind `if (process.env.OPENAI_API_KEY)`.

> **Timeline history / scroll-back (known gap — build the workaround).** There is
> no client wire method to *read* a session's timeline history. `timelineView`
> seeds from an `initial` array you must fetch **server-side** from the durable
> log (a `TimelineStore.history(...)` read) and hand to the client at boot — the
> AI-SDK `initialMessages` pattern. Add a tiny server endpoint (or a custom wire
> command) that returns `{ entries, oldestSeq }` for a session, and a
> "load older" endpoint that pages backward by `seq`. The client feeds these into
> `timelineView({ initial })` and `view.prepend(older)`. **Log this** — the thin
> client cannot page history on its own today. (There is a worked reference for
> exactly this recipe in the framework's `timeline-client-example` — read it.)

---

### §3. The client (the dashboard) — functional spec

One import gives you the batteries-included client; the session sub-handles
(`knobs`, `tasks`, `elicitations`, client-tools) self-assemble from it:

```ts
import { createClient } from "@agentick/client-next";
import { http } from "@agentick/transport-http-next";

const client = await createClient({
  transport: http({ url: "http://localhost:8787" }),
  onStateChange: (s) => setConnState(s),   // wire the connection indicator here
});
await client.connect();                    // the client does NOT auto-connect
```

> The HTTP transport handles the CSRF handshake **transparently**: the persistent
> GET notification stream issues a per-process token, and the transport echoes it
> on every mutation. You do not manage tokens. (If you pass `Authorization`, put
> it in `http({ headers })`.)

Build these panels. Every one must be backed by a **real** client API — no faked
state:

1. **Project / session picker.**
   - List existing sessions via `client.app(appId).listSessions(filter?)`;
     resume one with `client.session(id)`; create a new one with
     `client.app(appId).createSession({ sessionId? })`.
   - "Project" = an app id (or a metadata tag on the session — use
     `createSession({ metadata })` and filter on it). Pick whichever the real
     `SessionFilter` supports; do not invent filter fields.

2. **Conversation / timeline** (the center of the dashboard).
   - Seed with server-hydrated history (see §2), then live-tail with
     `timelineView(client, sessionId, { initial, fromCursor, visibility })`.
   - Bind to React with `useSyncExternalStore(view.subscribe, view.get)`.
   - **Scroll-back:** on scroll-to-top, fetch the previous page server-side and
     `view.prepend(olderEntries)`.
   - **Optimistic send:** `view.append([optimisticEntry])` with a client temp-id
     stamped on `message.metadata.clientId`, then `session.send({ messages: [{
     …, metadata: { clientId } }] })`. When the server echo folds back in, the
     window holds **both** copies — the framework does **not** dedup. Collapse
     them at render time by `clientId` (keep the last occurrence). This
     app-owned reconciliation is deliberate (the "no client cache" bright line) —
     implement it; do not look for a framework dedup seam.

3. **Live run: stream text + thinking + tool activity.**
   - `const handle = session.send({ messages })` returns a handle
     **synchronously** on the client (no `await` on the send itself).
   - Iterate `for await (const ev of handle.events())` and switch on `ev.type`
     against the **real** stream-event union. Expect at least:
     - text: `content-delta` (token deltas) and `content` (finished block);
     - thinking: `reasoning-delta` / `reasoning`;
     - tool activity: `tool-call` (model emitted a call),
       `tool-dispatch-start` / `tool-dispatch-end` / `tool-dispatch`
       (execution lifecycle + outcome), and
       `tool-confirmation-required` / `tool-confirmation-resolved`;
     - lifecycle: `tick-start` / `tick` / `execution-*`;
     - final: `result`.
     Verify the exact member set against the installed `.d.ts` and narrow on
     `.type` — do not hardcode a set you didn't confirm.
   - **Streaming discipline (mandatory).** Do **not** re-parse the entire
     accumulated markdown on every `content-delta`. That is quadratic and will
     visibly stutter on a long answer. **Batch** delta application to an animation
     frame (or a short debounce): accumulate raw text in a ref, flush to React
     state on `requestAnimationFrame`. Parse/highlight markdown on the flushed
     buffer, not per token. This is a known lesson — bake it in from the start.
   - `await handle.result` gives the final `SendResult` (`response`, `output`,
     `toolResults`, `usage`, `stopReason`, `ticks`).

4. **Composer: send / steer / follow-up / stop.**
   - **Send** (idle session): normal `session.send({ messages })`.
   - **Steer** (a run is in flight): `session.send({ messages, delivery: "steer" })`
     — injected into the *currently running* execution at the next tick boundary
     (after this tick's tool results, before the next model call). Same run, no
     settle wait.
   - **Follow-up:** `session.send({ messages, delivery: "followUp" })` — waits
     for the session to fully quiesce, then runs as a **new** execution.
   - **Stop:** `handle.abort(reason?)`.
   - Reflect the distinction in the UI (a "steer" chip while running vs a
     "queue follow-up" affordance). `delivery` defaults to `"steer"`.
   - Do **not** use a `session.queue(...)` method if you see one — it is a
     dangling wire stub with no server handler; `delivery: "followUp"` is its
     real replacement. (Log it if the type surfaces.)

5. **Client tools + confirmation dialogs.**
   - Declare the client's tool set with
     `session.setClientTools(declarations)` — a **whole-slice replace** (the set
     *is* the truth; re-declare on reconnect). Each declaration is serializable
     (`name`, description, raw JSON-Schema `inputSchema`) — no handler crosses
     the wire.
   - Handle inbound calls with the ergonomic router:
     `session.routeClientTools({ myTool: async (input, ctx) => result }, { onUnknown? })`
     — it dispatches, auto-responds with the result, and turns a throw into an
     error result so a suspended call never hangs. (The lower-level feed is
     `session.clientToolCalls` — a `ChannelStream` of handles with `.respond`;
     use it if you need custom UI per call.)
   - **Confirmation dialogs:** server-side tool confirmations arrive as
     elicitations with `hints.kind === "tool_confirmation"`. Use
     `session.confirmClientTools(policy)` where `policy` is `"approve"` /
     `"deny"` / `(req) => boolean | Promise<boolean>`. A truthy verdict sends
     `accept({ approved: true })`; render a modal and resolve the predicate from
     the user's click. **Do not also answer `tool_confirmation` in your generic
     elicitation loop** — last responder wins / double-respond. Pick one owner.

6. **Elicitations (generic human-in-the-loop).**
   - Consume `session.elicitations` — **a property, an `ElicitationsHandle`**
     (async-iterable + `.onChange(cb)` + `.respond(...)` + `.close()`), **not a
     method call.** (Much of the doc text and the package README write
     `session.elicitations()` with parentheses — that is stale; the working
     shape is the property. Log this drift.)
   - Each frame is a handle with `.accept(value)`, `.decline(reason?)`,
     `.cancel(reason?)`, plus `message`, `mode` (`"form"` | `"url"`), a JSON
     `schema` for form-mode UI, `hints`, and `metadata`.
   - Render a form from `schema` for `mode: "form"`; a link/redirect for
     `mode: "url"`. **Subscribe before you send** — the request channel is live
     (a request emitted before you attach may be missed; there is no snapshot
     replay of pending requests today). Log that constraint.

7. **Knobs / runtime controls.**
   - `session.knobs` is a live view + write: `session.knobs.subscribe(state => …)`
     / `session.knobs.get()` give a `Record<knobId, value>`, and
     `session.knobs.set(key, value)` writes (fire-and-observe — the write returns
     as a channel delta that re-folds the view; do **not** hand-patch locally).
   - **Known gap — the client sees VALUES only, not descriptors.** There is no
     wire method that enumerates knob schema (label, type, min/max, enum options,
     group). You must either (a) infer the control from the value's JS type
     (`boolean` → toggle, `number` → number input, `string` → text) — crude but
     dependency-free — or (b) hydrate a descriptor list **server-side** (same
     pattern as timeline history) and ship it to the client to render proper
     labeled sliders/selects. Pick (b) for a real dashboard and **log the gap.**

8. **Connection status + diagnostics.**
   - Drive a connection indicator from `onStateChange` (passed at construction,
     or `client.onStateChange(fn)`) — `idle` / `connecting` / `open` /
     `reconnecting` / `closed` / `{ kind: "failed" }`.
   - Do **not** try to build the status indicator from `client.events()` — that
     stream is live-only today and only the `connection` surface has a live
     source; use `onStateChange`.
   - Stream `session.onLog((e) => …)` into a collapsible diagnostics drawer.

9. **Responsive layout.**
   - **Desktop:** a three-pane console — session/project rail (left),
     conversation (center), controls + tasks + diagnostics (right).
   - **Mobile:** the panes collapse to a single column with a tab/drawer switcher;
     the composer stays pinned to the bottom; the conversation scrolls
     independently (fixed-height flex child with `min-height: 0; overflow: auto`).
   - Verify both at a narrow and a wide viewport.

---

### §4. Security posture (ride the defaults; be honest about policy vs boundary)

- The server transport binds **loopback (`127.0.0.1`) by default** and ships a
  safe web-security policy: cross-site requests rejected, `Host` allow-listed
  (DNS-rebind defense), CSRF token required on mutations, CORS never `*`. **Ride
  these defaults.** The only thing you configure for local dev is
  `allowedOrigins` for the Vite dev origin (different port ⇒ cross-origin). In
  production, serve the built client from the **same origin** and you need none
  of it.
- **Be honest in your write-up:** confirmation dialogs, tool allow-lists, and
  elicitation gates are **policy** seams — they shape what the agent is *allowed*
  to ask for. They are **not** a security boundary. The boundary is the
  OS-level sandbox (Landlock/Seatbelt-class isolation) around tool execution and
  the loopback bind. A dashboard button that says "deny" is UX, not containment.
  State this plainly; do not sell confirmation UI as a security control.

---

### §5. Testing — with the FAKE model (no tokens)

- **Unit-test the client glue** against a fake transport / scripted server: the
  optimistic-append + `clientId` reconciliation reducer, the batched-delta
  accumulator, the knob-control-from-value-type inference, the stream-event
  reducer. These are pure functions — test them directly.
- **Integration-test the whole loop with `scriptedAdapter`.** Stand up the real
  gateway with `model: scriptedAdapter("hello **world**", { chunks: ["hello ",
  "**world**"], thinkTags: true })`, connect a real client over the HTTP (or
  in-process) transport, `send`, drain `events()`, and assert you saw
  `content-delta` → `content` → `result`, that the timeline view folded the
  echo, and that a `tool_confirmation` flowed through `confirmClientTools`. **No
  provider key, no tokens, deterministic.**
- Note on the fake tiers you'll encounter: the **ergonomic** no-token path is
  `model: scriptedAdapter(...)` on `createApp` / `gateway.createApp`. There is
  also a lower-level `FakeLanguageModelExecutor`, but its constructor takes raw
  substrate handles (`scopeId, journal, bus, inbox, options`) and is intended
  for framework-internal harness tests — **do not** reach for it from adopter
  code; use `scriptedAdapter` via the `model` slot. (Log this: the doc names the
  executor, but adopters want the adapter.)
- **A single optional real-provider smoke test**, gated behind `OPENAI_API_KEY`,
  skipped by default.

---

### §6. Definition of done (all must be true — verify each by running)

- [ ] `pnpm dev` (or equivalent) starts the server **and** the Vite client; the
      dashboard loads with the connection indicator showing `open`.
- [ ] I can create a new session and resume an existing one from the picker.
- [ ] Sending a message streams tokens into the conversation **smoothly** (no
      per-token full re-parse), with thinking and tool activity visible.
- [ ] Steer works mid-run; follow-up queues correctly; stop aborts.
- [ ] An elicitation-gated tool surfaces a dialog; approving it lets the run
      proceed; declining stops it.
- [ ] A client tool round-trips through `routeClientTools` and its result
      appears in the run.
- [ ] Knob controls reflect live state and writing a knob re-renders the agent.
- [ ] Task status updates live while a task tool runs.
- [ ] Scroll-back loads older history via the server hydrate path.
- [ ] The layout is usable at 375px and at 1440px.
- [ ] `vitest` passes; the integration test drives the full loop on the fake
      model with **zero** tokens spent.
- [ ] `tsc --noEmit` is clean.
- [ ] The **friction log** is delivered (see below) with every hedge, workaround,
      and naming warning I hit.

### §7. Deliver the friction log

Alongside the code, deliver a `FRICTION.md`: every place you had to hedge,
work around a missing capability, write glue the framework should have shipped,
or warn a future reader about a confusing/stale name. Format each as
**friction → severity (blocker / high / medium / low) → suggested fix**. This
log is a required output — it is how the framework improves. Do not omit an item
because you found a workaround; the workaround *is* the friction.

---

## Notes for the human running this prompt

The gaps the prompt tells the agent to route around are **real, known gaps** in
the current client surface — they are not the agent failing. They are catalogued,
with severity and suggested fix, in
[`one-shot-friction-log.md`](./one-shot-friction-log.md). That log is the point
of the exercise: it is the B2 work list, generated by attempting a realistic
build against the real APIs.
