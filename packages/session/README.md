# @agentick/session

**One conversation, one session.** A session owns the durable conversation, the state a run accumulates, and the single verb that runs an agent: `session.send({ messages })`. It is the integration site — the compiled tree, the loop, the model, the tool registry, the timeline, knobs, gates and tasks all meet here, and everything an adopter does to a live agent goes through this object.

Most adopters never construct one. `createApp` builds sessions for you; `app.createSession()` opens or resumes one by id.

## Install

```bash
npm install @agentick/session
```

Subpath: `/testing` (the resume acceptance suite + the session-store conformance suite). [@agentick/app](../app) already depends on this package, so `createApp` has it.

## Quick start

Configuration is app-level, and each layer is a first-class slot on `createApp`. `createSession` takes no messages — it opens a conversation. `send` runs it.

```tsx
import { createApp } from "@agentick/app/react";
import { System } from "@agentick/compiler-react";
import { defineTimeline } from "@agentick/timeline";

function Agent() {
  return <System>You are a helpful assistant.</System>;
}

const app = await createApp(<Agent />, {
  model, // an adapter — openai("gpt-4o"), anthropic(…), …
  timeline: defineTimeline({ store }), // durable conversation
});

// Open (or resume) a conversation. Same id twice = the same session.
const session = await app.createSession({ sessionId: "s:1" });

const handle = await session.send({
  messages: [{ role: "user", content: "What changed in the last release?" }],
});

for await (const event of handle.events()) {
  if (event.type === "tool-dispatch-start") log.info({ tool: event.name });
}

const { response, usage, stopReason } = await handle.result;
```

For a runtime-built or conditional install, `extensions: [withTimeline(definition)]` takes the same definition — the slot is the front door, `extensions` is the escape hatch.

### What a session hands you

Each surface below is contributed by its own package and points at the same instance the JSX tree sees. Nothing is hardcoded on the session.

| Surface                                | What it is                                             | Lives in                          |
| -------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `session.timeline`                     | The conversation — read, append, compact, page history | [timeline](../timeline)           |
| `session.knobs` / `session.knob(name)` | Model-visible, model-settable config                   | [knobs](../knobs)                 |
| `session.state`                        | Adopter K/V stash; not model-visible                   | [state](../state)                 |
| `session.gates` / `session.gate(name)` | Loop-continuation gates, tree-declared or programmatic | [gates](../gates)                 |
| `session.tools`                        | Tool registry reads + the host door `dispatch()`       | [tool-executor](../tool-executor) |
| `session.tasks`                        | Long-running work registry                             | [tasks](../tasks)                 |
| `session.resources`                    | Resource reads without a tool ctx                      | [resources](../resources)         |
| `session.elicit` / `.elicitation`      | Ask the user for typed input                           | [elicitation](../elicitation)     |
| `session.model`                        | Model selection and swap                               | this package                      |

```ts
session.timeline.read().entries; // what the model will see next tick
await session.knobs.set({ id: "verbosity", value: "terse" });
await session.tools.dispatch("rename_file", { from: "a", to: "b" }); // no model involved
```

Optional installs contribute slots the same way — `session.prompts` ([prompts](../prompts)), `session.skills` ([skills](../skills)), `session.live` ([live](../live)) — so they are typed as optional and present only when their package is mounted.

## The execution handle — two views of one run

`send()` resolves to a `SessionExecutionHandle`. It is not the result; it is the run. Await `.result` for the final outcome, iterate `.events()` for the stream, and both derive from the same execution — iterating does not consume the result, and awaiting the result does not starve another iterator.

```ts
const handle = await session.send({ messages });

handle.executionId; // stable id, stamped on every event and timeline entry
handle.status; // "running" | "completed" | "error" | "aborted"

const events = (async () => {
  for await (const ev of handle.events()) log.debug({ seq: ev.sequence, type: ev.type });
})();

const result = await handle.result; // SendResult
await events;
```

Events carry a dense, monotonic per-session `sequence`, so a UI can order, replay, or de-duplicate them. `handle.abort("user cancelled")` tears the in-flight execution down structurally; the result settles with `stopReason: "aborted"`. A `timeoutMs` on the send does the same on expiry with `stopReason: "timeout"`. `session.abort(reason)` is the same cancellation for a caller holding the session rather than the handle.

### The same stream, as web streams — `readable()` / `pipeTo()`

`events()` is the async-iterable view; `readable()` is the same stream as a WHATWG `ReadableStream<StreamEvent>` — the bridge to `pipeThrough`, `tee`, and manual backpressure. `pipeTo(destination)` drains the run into any `WritableStream<StreamEvent>`, and the destination's backpressure **is** the pacing mechanism: a slow sink's `write()` gates the drain, so a rate-limited target (a chat surface editing a message) needs no extra buffering. This is the same web-streams-with-backpressure model the [`live`](../live) package uses for media.

```ts
// Ship an execution straight to a rate-limited sink (e.g. a connector's thread writer).
await handle.pipeTo(sink, { throttleMs: 300 }); // throttleMs is optional smoothing on top of backpressure

// Or take the ReadableStream and compose transforms.
handle.readable().pipeThrough(myTransform).pipeTo(sink);
```

`throttleMs` enforces a minimum gap between writes for a sink that prefers cadence over raw token rate; omit it and backpressure alone paces. The remaining `pipeTo` options mirror `ReadableStream.prototype.pipeTo` (`signal`, `preventClose`, …). `readable()`/`pipeTo()` draw from the same underlying queue as `events()` — consume a handle through one of them, not several at once.

### How far an abort reaches

`abort()` stops one execution. `abort(reason, { cascade: true })` stops the session's whole live spawn subtree — every descendant's current execution, deepest-first, so a child stops before the parent waiting on it unwinds:

```ts
await session.abort("user pressed stop", { cascade: true });
```

Cascade is **scope, not kind**: each aborted execution mints the same `loop:abort` operation a solo abort does, and nothing is disposed, no record is touched, and detached tasks keep running. The session is immediately sendable again. For the rungs above it — `close()`, `destroySession()` — see the [cancellation ladder](../app#the-cancellation-ladder).

A sub-agent spawned **during** an execution needs no cascade: it inherits that execution's teardown signal, so cancelling the turn cancels the work the turn started. What cascade adds is reach over children the session kept across turns.

Streaming is a cascade: `send({ stream })` beats `createSession({ streaming })` beats `createApp({ streaming })` beats the model's own capability. With streaming off the handle still yields summary events (`message`, `content`, `tool-call`) — just not deltas.

## Steering — a send during a running execution joins it

There is no pending queue. A `send()` while an execution is in flight appends its messages and returns **the in-flight handle**: the loop runs another tick, and the model addresses the new input in the same execution.

```ts
const handle = await session.send({ messages: [{ role: "user", content: "refactor the parser" }] });

// …the agent is three ticks deep…
const same = await session.send({ messages: [{ role: "user", content: "wait — dry run only" }] });
same === handle; // true — the running execution absorbed the correction
```

The steer lands at the next tick boundary — after that tick's tool results apply, before the next render — so `tool_use`/`tool_result` adjacency is never broken. On an idle session a steer is just a normal send.

`onBusy` names the other choice:

```ts
// Wait for the session to fully quiesce, then run a FRESH execution.
await session.send({ messages, onBusy: "queue" });
```

Unset, `onBusy` resolves per send shape: a send carrying structured output (`output` or `responseFormat`) defaults to `"queue"`, because a steer joins a turn whose ending is already committed and so has no final turn of its own to shape; every other send defaults to `"steer"`. An **explicit** `onBusy: "steer"` carrying structured output that actually joins is rejected with `SteerCannotCarryStructuredOutput` rather than silently dropping the directive.

## Structured output — `output` in, `data` out

Pass a schema and get a validated value back:

```ts
import { z } from "zod";

const Answer = z.object({ summary: z.string(), risk: z.enum(["low", "high"]) });

const { response, data } = await (await session.send({ messages, output: Answer })).result;

data?.risk; // typed + validated
response; // any prose the model emitted alongside it
```

**The delivery mechanism is a terminal tool.** The loop injects a synthetic tool whose input schema _is_ your output schema (default name `submit_result`); the model calls it to deliver the answer, and that call is the completion event. This ties "done" to "shaped" and makes validation free — every provider constrains tool arguments natively. The terminal tool is never registered and never dispatched: the loop captures its raw input, validates it, and lifts the validated value onto `SendResult.data` with `stopReason: "output_delivered"`. A synthesized `tool_result` pairs the call in the timeline so the next send starts clean.

Strategy selection is capability-aware. With `strategy: "auto"` (the default) the loop picks the terminal tool whenever real tools are mounted **or** the target has no native `json_schema` support; it falls back to a plain `responseFormat` directive on a bare send to a target that does support it, and degrades to that honestly when a target supports neither.

Be precise about what is guaranteed:

1. **Natural path.** The tool's presence and description usually elicit the call. Whether a given model complies unforced is model behavior — measure it with [@agentick/eval](../eval), don't assume it.
2. **Forced path.** If the model finishes without calling the terminal tool, the loop runs one wrap-up tick with `toolChoice` pinned to it. The provider cannot answer without calling it, with arguments constrained to the schema.
3. **Typed failure.** At the tick cap with no room to wrap up, the send rejects with `StructuredOutputIncomplete`. A delivered value that fails the schema rejects with `ResponseValidationError` (carrying `issues` and `raw`). Errors over nulls.

A tree-level `<Output>` says "every execution of this agent produces this shape" — the extraction-agent case — and produces a validated `data` too, because the loop is the validation authority either way. A send-level `output` overrides it. A tree tool colliding with the terminal name fails the send with `TerminalToolNameCollision`; two `<Output>`s fail with `MultipleStructuredOutputs`.

```tsx
import { Output, System } from "@agentick/compiler-react";
import { z } from "zod";

function Extractor() {
  return (
    <>
      <System>Extract the invoice fields.</System>
      <Output schema={z.object({ total: z.number(), vendor: z.string() })} />
    </>
  );
}
```

> [!NOTE]
> `output` holds a live validator, so it cannot cross the wire. `responseFormat` is the serializable twin — a JSON-shaped directive applied on every tick, overriding both a tree-level `<model responseFormat>` and a per-tick `<Model>`. Wire callers declare `responseFormat` and parse `response` themselves. OpenAI and Google honor it natively; Anthropic and the ai-sdk adapter currently drop it, which is exactly the gap the terminal tool closes.

```ts
await session.send({
  messages,
  responseFormat: { type: "json_schema", name: "answer", schema: { type: "object" } },
});
```

## Restricting what one send exposes

`allowedTools` filters the merged, precedence-resolved model-visible tool list down to an allowlist of canonical names. It applies after the compiler-tools merge and before terminal-tool injection, so the loop's own terminal tool is exempt.

```ts
await session.send({
  messages,
  allowedTools: ["read_file", "grep"], // the model sees these two, nothing else
});
```

It composes additively with `tools` (an execution-scoped tool must _also_ be named to reach the model), and the dispatch door is untouched — `session.tools.dispatch("write_file", …)` still works. Restricting to an empty set makes the send behave as if no tools were mounted, which is what `"auto"` strategy resolution reads.

Execution-scoped tools live and die with the send:

```ts
await session.send({
  messages,
  tools: [reviewTool], // registered for this execution, removed when it ends
});
```

## Choosing and swapping the model

`session.model` is the model-selection surface. `setModel` swaps the runner and its target; `setTarget` swaps only the target, keeping the runner. Both are journaled and hookable, and both take effect on the **next** send — never mid-execution.

```ts
import { openai } from "@agentick/model-openai";

session.model.current; // the session default in effect right now

await session.model.setModel(openai("gpt-4o")); // adapter sugar, same as construction
await session.model.setTarget({
  kind: "language-model",
  provider: "openai",
  modelId: "gpt-4o-mini",
});
```

The adapter form is wrapped into an executor for you. An app built with a BYO `modelExecutor` opted out of that machinery, so passing a bare adapter there throws `ModelExecutorBuilderMissingError` — pass a `{ modelExecutor, target }` pair instead. Either form normalizes before the command fires, so a policy hook sees identical input:

```ts
session.hook({
  onBeforeSessionSetModel: (input) => {
    if (denylist.has(input.target.modelId)) throw new Error("model not allowed");
  },
});
```

### Interceptors that survive a swap

A swap can replace the whole executor, so an interceptor registered on executor A evaporates the moment you move to executor B. `session.model.use` and `.guard` register against the model-call operation rather than any executor instance, and one execution is one fiber, so they reach whichever executor actually issues a call — including a per-tick `<Model>`-swapped one. Registered once, they hold across every subsequent swap.

```ts
// A metering transform on every model call — survives setModel.
const offUse = session.model.use(async (input, next, ctx) => {
  metrics.count("model.calls");
  log.debug({ op: ctx.op, opId: ctx.opId });
  return next(input);
});

// Admission control on the model call. Guards compose outermost, so no
// transform can swallow a veto.
const offGuard = session.model.guard((_input, ctx) =>
  overBudget(ctx) ? { kind: "veto", reason: "cost ceiling" } : undefined,
);
```

Effective-model precedence is unchanged by any of this: a per-tick `<Model model={…}>` beats a per-send `send({ modelExecutor, target })`, which beats the session default. `setModel` moves only the default.

## Spawn, fork, lineage

`spawn` creates a child session bound to the same app. Omit `agent` and the child is a same-image copy of its parent; supply `send` and the spawn runs one execution and hands you the child's handle instead of the child.

```tsx
const child = await session.spawn({ agent: <SubAgent />, initialKnobs: { depth: 1 } });
const handle = await session.spawn({ send: { messages: [{ role: "user", content: "audit" }] } });
```

`fork()` is spawn plus a restore of the parent's live snapshot: the child copies every snapshot-capable surface (timeline, knobs, state, gates) and the tick/usage accounting, gets its own id and lineage, and is **always returned unbound** — a fork never auto-sends. From that instant the two diverge; a knob set on one is invisible to the other. This is the isolation primitive behind `skills.run(name, { isolate: true })`.

```ts
const branch = await session.fork();
await (
  await branch.send({ messages: [{ role: "user", content: "try the risky plan" }] })
).result;
await branch.close(); // the parent never saw it
```

Three things are enforced on the parent side:

- **Depth.** Every session carries a `spawnPath` (ancestor ids, root-first) and a ceiling (`createApp({ sessions: { maxSpawnDepth } })`, default 10). A session already at the ceiling throws `SpawnDepthExceededError` — fail-closed against runaway self-spawn. Depth _is_ `spawnPath.length`; there is no second counter.
- **Attribution.** `spawnPath` is stamped on the child's durable record, on the loop's execution and tick event scopes, and on every event the child's handle emits — it describes the **emitter's** lineage, not a routing header. With `parentSessionId`, the spawn tree reconstructs from records alone.
- **Teardown.** The parent's construction signal fans into each child, and the parent disposes its children on close and on abort. Disposal waits for quiescence first, so closing never unmounts a compiler mid-tick. Sub-trees collapse transitively.
- **Turn ownership.** A child spawned from inside an execution also inherits that **execution's** teardown signal, and records the turn that made it (`originExecutionId`, plus the `originCallId` of the tool call). Cancel the turn — abort, timeout, failure — and its sub-agents go with it; let the turn succeed and they keep running, reachable afterwards through [`app.abortExecutionTree`](../app#cancelling-one-turns-fan-out).

### Watching a spawn from the parent's stream

A spawn-and-run puts a bracketing pair on the **parent's** event stream: `spawn-start` (`spawnSessionId`, `spawnExecutionId`, `originCallId?`) when the child execution begins, `spawn-end` (`spawnSessionId`, `isError`) when it settles. That is enough to draw a live spawn tree — a node appears, gets a status, and attaches to the tool call that asked for it:

```tsx
const SpawnTool = createTool({
  name: "delegate",
  description: "Hand the task to a sub-agent",
  input: z.object({ task: z.string() }),
  handler: async ({ task }, { ctx }) => {
    const handle = await session.spawn({
      agent: <Auditor />,
      send: { messages: [{ role: "user", content: task }] },
      originCallId: ctx.toolCallId, // ← the edge the spawn tree draws
    });
    return (await handle.result).output;
  },
});
```

`originCallId` is passed, not inferred. `spawn()` runs its operation on a fresh fiber that cannot see the dispatch's ambient context, so the call id travels as data — the same reason `parentOpId` is threaded explicitly.

**A child's interior events stay on the child's handle.** Nothing is bubbled from one handle onto another, and the parent's stream carries the two boundary events only. Three reasons, in order of weight:

1. `sequence` is a **per-handle** monotonic counter, and it is what durable replay and gap detection key on. Merging a second session's events into a handle either breaks that monotonicity or re-numbers foreign events, at which point the same event carries two different sequence numbers on two streams.
2. The wire fan-out is scoped to **one execution's** progress token. Bubbling would put a second session's events on another session's token, behind whatever authorization admitted the first — the gateway's per-session grant checks would no longer describe what the client receives.
3. The boundary pair already answers the question a spawn tree asks (which child, started by which call, ended how). Interior child deltas are a separate, opt-in subscription — deliberately not paid for by every parent.

To watch a child's interior, hold its handle: `const handle = await session.spawn({ send })` returns the child execution's handle and `handle.events()` is its full stream, with `spawnPath` stamped on every event for attribution.

Ownership descends: a child inherits its parent's `principal` (not caller-choosable), which is what the wire dispatch gate reads for its same-principal rule. `createSession({ requiredScopes })` sets the complementary ceiling on the work axis — a construction-bound, server-declared scope requirement checked structurally at the wire gate before any policy runs.

## Asking the user

Two surfaces, one substrate. `session.elicit` is the typed sugar and the 90% case; it is the identical `Elicit` interface a tool handler sees as `ctx.elicit`, in-process or over MCP.

```ts
import { ElicitationCancelled, ElicitationDeclined } from "@agentick/spec";

const name = await session.elicit.text("Your name?");
const role = await session.elicit.select("Role?", ["admin", "user"] as const);

try {
  await session.elicit.confirm("Apply changes?");
} catch (err) {
  if (err instanceof ElicitationDeclined) log.info({ declined: true });
  if (err instanceof ElicitationCancelled) log.info({ cancelled: true });
}

// Non-throwing variants return a discriminated outcome.
const outcome = await session.elicit.tryConfirm("Apply?");
if (outcome.status === "accept" && outcome.value) log.info({ applied: true });
```

`session.elicitation` is the raw substrate underneath — reach for it when you need a bespoke Standard-Schema validator, hints, or timeout/abort control that the sugar doesn't expose. See [@agentick/elicitation](../elicitation) for the full contract.

### Mediating a descendant's ask

An ask raised deep in the ownership tree — a long-running task's `ctx.elicit`, or a spawned sub-agent's — travels up the spawn lineage. A root session resolves it against the real client; a spawned session forwards one hop to its own spawner. You wire none of that. What you _can_ do is answer on the way past:

```ts
const off = session.interceptEscalation(async (payload) => {
  if (payload.class === "elicit" && cache.has(payload)) {
    return { forward: false, response: { outcome: "accepted", value: cache.get(payload) } };
  }
  if (isRateLimited(payload)) throw new Error("denied"); // hard deny at the origin
  return { forward: true }; // fall through to forward or resolve
});
```

`{ forward: false, response }` short-circuits — this hop answered and the client is never bothered. A throw is a hard deny that surfaces as the origin's rejection. `{ forward: true }` falls through. The handler branches on `payload.class` itself; there is no policy DSL. With none registered, behavior is plain forward-and-resolve. The envelope carries a `lineage` path (origin task and session, then each forwarding hop) the interceptor can inspect.

## Waking on task completion

A backgrounded task that finishes while nothing is observing it wakes its owning session, and the wake becomes a **real turn** through the normal `send` path — journaled, hooked, streamed. So a wake arriving mid-execution steers into it rather than colliding with a second execution, and an idle session runs a fresh one.

The synthesized turn is labelled authoritatively, so timelines and clients never mistake it for a user turn:

```ts
session.hooks.onBeforeSessionSend((input) => {
  if (input.metadata?.source === "task-wake") {
    log.info({ wokenBy: input.metadata.taskId });
  }
});
```

The wake carries bounded completion metadata — task id, terminal status, duration — and never raw output. Whether a task wakes at all, and with what message, is a task-level policy (`wake` per task, or `tasks.defaultWake` app-wide) in [@agentick/tasks](../tasks); the session owns only the receive-and-send half.

## Snapshot and restore

`snapshot()` captures the whole session; `restore()` puts it back. Neither method knows the name of a single layer: both fold **every** snapshot-capable surface generically, keyed under `bridges`.

```ts
const snap = await session.snapshot();
snap.bridges.timeline; // persisted log + projection
snap.bridges.knobs; // knob values
snap.bridges.state; // K/V state
// …plus any installed extension that can snapshot — zero session change

await session.restore({ snapshot: snap });
```

Add a snapshot-capable extension (sandbox, subscriptions, your own) and it round-trips automatically. One authoritative payload per layer, so nothing can diverge from a denormalized copy.

Both are commands, so the hook quartet falls out for free: `onAfterSessionSnapshot` transforms the captured snapshot on its way out (the redaction seam), `onBeforeSessionSnapshot` can veto the capture, and the restore pair mirrors them.

```ts
session.hooks.onAfterSessionSnapshot((snap) => ({ ...snap, metadata: redact(snap.metadata) }));
```

**Schema evolution is a callback at the decision point.** A snapshot whose `specVersion` differs from the running version is a migration event. Supply one function and own any version dispatch inside it; supply none and a skew throws `SnapshotVersionMismatch` rather than applying a stale shape.

```tsx
import { createApp } from "@agentick/app/react";

const app = await createApp(<Agent />, {
  model,
  migrateSnapshot: (snap, { from, to }) => upgrade(snap, from, to),
});
```

> [!NOTE]
> This is distinct from resume. A durable `TimelineStore` hydrates the conversation at open, and `createSession` with a known id is create-and-resume. `snapshot()`/`restore()` is the on-demand full-session capture and transplant — it moves knobs, state and every extension too, and it is what a fork is built on.

## Seeing what a tick would send

`dryRun()` compiles the current tree and stops one step short of the provider:

```ts
const { tree, input, request } = await session.dryRun();
```

| rung      | artifact             | answers                             |
| --------- | -------------------- | ----------------------------------- |
| `tree`    | `RenderedTree`       | what the components produced (IR)   |
| `input`   | `LanguageModelInput` | what the MODEL sees, post-formatter |
| `request` | provider-native      | what would go on the wire           |

Nothing is sent, no timeline entry is written, and the tick counter does not
move — two consecutive dry runs leave `snapshot()` byte-identical, which is what
`@agentick/app`'s `dry-run.spec.tsx` pins.

**It is not free of side effects, and assuming otherwise will mislead you.**
Answering means rendering, so `useData` fetches, suspense resolves, and lifecycle
hooks on the render path fire. For a retrieval-backed agent a dry run issues a
real retrieval query.

The rungs are also available on their own, because they fail differently:

```ts
const tree = await session.compile(); // needs no model
const input = await session.project(tree); // needs a model; reuses the tree
const request = session.prepareRequest(input);
```

`compile()` works on a session with no model bound; `project()` and
`prepareRequest()` throw `NoModelForExecutionError`. `request` is `undefined`
when the executor has no provider adapter behind it (a fake, a replay double),
and it is the request BEFORE `onBeforeModelProviderRequest` hooks run — so a hook
that rewrites the native request is not reflected.

### Over the wire

```ts
const { tree, input } = await client.session(id).dryRun();
```

`session/dry_run`, `session/compile` and `session/project` resolve the session
through the same ownership rules as every other session verb, so a caller
reaches only their own. The provider-native rung deliberately does NOT cross:
it is adapter-shaped and not guaranteed JSON-clean, so it stays where the adapter
that produced it lives.

> [!IMPORTANT]
> The response is the entire prompt — system instructions, retrieved context, the
> user's identity block. It is the most sensitive read in the session namespace.
> Authentication scopes it to the caller's own sessions; a deployment that treats
> prompt contents as privileged should gate the verbs beyond that.

## Asking the conversation about itself — `reflect()`

`reflect()` is one more turn of this session with an extra instruction on the
end. Compaction, episodic memory, thread titling and post-mortem critique are
that one operation under different instructions.

```ts
const { text, usage } = await session.reflect({
  instructions: "In three sentences, what is this conversation about?",
});
```

**Appending at the END is the whole trick.** The prefix stays byte-identical to
the next tick's, so the provider reads it from cache instead of charging for it
again — and the model sees the system prompt, the grounding and the whole
conversation, because it _is_ the turn it would otherwise have taken. Nothing is
appended to the timeline: a reflection is a question about the conversation, not
a move within it.

What the model does **not** see is the agent's tools. A reflection wants an
answer, and a model handed a tool reaches for it instead of answering.

**Ask for a shape and you get one.** `output` and `data` are the same fields
`send` uses, with the same semantics — a reflection is not a second structured-output
dialect:

```ts
const Fold = z.object({ summary: z.string(), questions: z.array(z.string()) });

const { data } = await session.reflect({
  instructions: "Summarize the conversation and name the questions it answers.",
  output: Fold,
});

data?.questions; // typed + validated — no regex over the prose
```

The one exception to the no-tools rule is how that answer arrives. The delivery
strategy resolves exactly as it does for a send: a target with native
`json_schema` decoding gets a `responseFormat` directive, and every other target
gets the synthetic terminal tool — which is therefore the only tool a reflection
ever advertises, with `toolChoice` pinned to it from the start. A send can spend
a second tick forcing a wrap-up; a reflection has one shot, so it forces the
choice immediately. A reply that never calls the tool raises
`StructuredOutputIncomplete`, and a reply that calls it with the wrong shape
raises `ResponseValidationError` — the same two errors a structured send raises.

> [!NOTE]
> `send` carries a serializable `responseFormat` twin because a send crosses the
> wire and a live validator cannot. A reflection is in-process by construction —
> it takes an `AbortSignal` and an `onDelta` callback — so there is nothing for
> that twin to buy, and `output` is strictly better on every provider. `reflect`
> takes `output` only.

## The render ↔ runtime feedback loop

A session is the per-render fact producer for the loop. Each send hands the loop two resolvers it calls per tick, which is how the tree renders _for the model it is about to call_, _within the window it has left_:

- The active model's context window and a projection of the model itself fold into one render envelope. `useContextInfo()` and `useActiveModel()` read it synchronously while producing output — that is what makes budget-aware compaction possible without a round trip.
- A tree-declared `<Model>` is resolved per tick against the model bridge, and the loop runs _that_ executor and target for that tick. Undeclared falls back to the session default.

The backward half closes the loop: after each tick the session appends the assistant message with that generation's usage, then the tool results, so the _next_ render sees them.

### What a turn cost

The assistant entry carries more than tokens. Each tick lands `usage`, the `model` that produced it, and the `cost` the loop stamped **at act time** on the entry's metadata — computed once, against the rate card in force then, and never recomputed. A price published tomorrow cannot reprice yesterday's records, because the record holds a number and a `rateRef`, not a recipe.

Those per-tick facts fold upward, per model, at every level: `SendResult.byModel` / `.cost` for the send, the turn-boundary record for the turn, and `SessionRecord.byModel` / `.cost` for the whole session — all of which survive snapshot and restore. The flat `usage` stays beside them because "how many tokens did this burn" is a real question with a real flat answer; it is just not a priceable one, since a session that changes model mixes rate tiers in one bag.

Cost is honest about what it does not know. A tick with no rate card is **unpriced**, and an unpriced tick never folds in as zero:

```ts
const { usage, byModel, cost } = await handle.result;

if (cost?.kind === "complete") render(`$${cost.amountMicros / 1e6}`);
else if (cost?.kind === "partial")
  render(`at least $${cost.amountMicros / 1e6}`); // + cost.unpricedTicks
else render("—"); // no usage recorded at all
```

Zero is a claim — "this cost nothing" — and a run mixing one priced model with one unpriced one would otherwise produce a total that looks authoritative and silently under-reports. The union forces the reader to notice. Rates ride the model (`ExecutionTarget.rates`); dynamic pricing rides `createApp({ costResolver })`, which wins over declared rates whenever it returns a value. A spawned child accounts for itself: its cost lands on its own record and never rolls into its parent's, because "what did this agent tree cost" is a query over `spawnPath`, not a write-time total.

#### Watching cost, without sourcing it from metrics

The stamp happens once and is projected twice. Everything above is the **truth plane** — durable, complete, per-model, and what billing reads. Alongside it the session emits a **metrics mirror** of the same facts, so a dashboard can watch spend without querying records:

| Instrument                          | Kind      | Labels                            |
| ----------------------------------- | --------- | --------------------------------- |
| `agentick.session.tick.cost_micros` | histogram | `provider`, `modelId`, `currency` |
| `agentick.session.tick.tokens`      | histogram | `provider`, `modelId`, `kind`     |
| `agentick.session.tick.unpriced`    | counter   | `provider`, `modelId`             |

One observation per tick, never a pre-aggregate. `kind` is the `TokenKind` vocabulary the rate cards price in (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`), so a panel joins straight to a `RateCard.perMTok` key — and a kind the provider did not report emits **nothing**, because a `0` in a histogram claims the model did no cache writes and drags every percentile down with it. The prefix follows `telemetryNamespace`; every emission is a no-op against a frozen singleton when no meter is wired.

The honesty rule holds on this plane too, which is what `unpriced` is for: a dashboard showing spend must be able to show how much of the spend it could not see. And the direction is one-way by design — **money must never live only in metrics.** A metrics pipeline samples, aggregates, expires series and drops labels under cardinality pressure; it is a fine place to watch cost and a catastrophic place to source it. Nothing here is the only writer of a number, and nothing reads it back for accounting. That is also why `rateRef` is not a label: it is dated, so it would mint a new time series on every price change, forever. Per-tick identity (session / execution / tick ids) is likewise absent — it rides spans and logs.

```tsx
import { useContextInfo } from "@agentick/compiler-react";
import { Timeline } from "@agentick/timeline/react";

function AdaptiveTimeline() {
  const { utilization } = useContextInfo(); // 0..1 — live, from the session
  return <Timeline strategy="sliding-window" headroom={(utilization ?? 0) > 0.75 ? 4096 : 8192} />;
}
```

### Continuation is the session's decision

Once per tick — after the tree has settled — the session folds every continuation predicate it owns into one verdict, in tier order:

1. **Stop.** A trusted tree `stopAfterTick` (via `useLoopControl`) halts the loop. Gates can only ever force _continue_, so a stop is provably tree code: the model cannot stop-force.
2. **Continue.** An engaged gate, a tree `continueAfterTick`, or steering (input appended mid-execution). A gate holds the loop open exactly the way a steer does.
3. **Abstain.** Nothing to say — the loop's own default (pending `tool_use`) applies, under its tick cap.

Settle-then-decide is load-bearing: a tick-end effect may set a knob a gate reads, so the tree must settle before the predicates run. That ordering is what makes `useOnTickEnd` usable as a real hook rather than a fire-and-forget notification — and the whole `useOn*` family is a projection of the real command lifecycle, not a bespoke feed.

### Retrying a failed tick

A tick that FAILED reaches the same fold, and a `continue` there is a retry — a failed tick persists nothing, so the next tick renders the same tree over the same conversation and issues an identical model request. The fold's default inverts for that outcome: abstain means stop, so a run with no policy ends on `executor_failed` exactly as before.

The bundled policy retries a `MalformedModelOutput` — the model emitted a tool call nobody can parse — once, and stops on everything else. A refused request is refused identically on the next tick, and billed. Replace it with either form of `tickFailurePolicy`:

```tsx
const session = new SessionHarness(journal, bus, inbox, {
  // ...
  // A per-class retry budget, keyed by the `_tag` adapters emit…
  tickFailurePolicy: { MalformedModelOutput: 2, StreamFailed: 1 },
  // …or the live predicate the table desugars into:
  // tickFailurePolicy: (error, { consecutiveFailures }) =>
  //   error._tag === "MalformedModelOutput" && consecutiveFailures < 3 ? "retry" : "stop",
  maxConsecutiveFailedTicks: 3,
});
```

Either form REPLACES the bundled default entirely — a table that omits a class is you saying that class should not retry. The loop's `maxConsecutiveFailedTicks` (default 3) and `maxTicks` still bound both, so raise the cap before raising a budget past it. The taxonomy is the config namespace: there is no `max<Mode>Retries` option per failure class, and a typo breaks at compile time.

Layering: an adapter-level `withRetry` owns transient transport errors (429/5xx/network) before the first chunk. This owns post-stream failures — the classes `withRetry` correctly refuses to replay. And the tree participates without any of it: `useOnTickEnd` sees the failed `TickResult`, and `useLoopControl().continueAfterTick()` re-issues the tick.

## Middleware, guards, and hooks

`session.use(mw)` wraps **this session's** operations — narrower than `app.use`, which wraps every session. Reach for it for concerns bound to one conversation: per-session rate limiting, a redaction pass, request logging keyed to `ctx.sessionId`.

```ts
session.use(async (input, next, ctx) => {
  log.debug({ session: ctx.sessionId, op: ctx.op, opId: ctx.opId });
  return next(input);
});
```

The async form severs the fiber; `session.fx.use` is the in-fiber twin. Because the loop, executors and tool registry are app-shared singletons — construction _siblings_ of a session, not children — middleware that must wrap the model call or a tool dispatch **for one send only** is call-scoped instead: `session.model.use` above is exactly that seam, alive for the fiber of a send and gone when it settles. See [@agentick/runtime](../runtime) for the full tier model and the `use` vs `fx.use` split.

Every public verb routes through the operation runner, so each one mints a typed before/after hook pair:

| Verb                            | Hooks                                                |
| ------------------------------- | ---------------------------------------------------- |
| `send`                          | `onBeforeSessionSend` / `onAfterSessionSend`         |
| `appendEntry`                   | `onBeforeSessionAppend` / `onAfterSessionAppend`     |
| `applyExecutorResult`           | `onBeforeSessionApplyExecutorResult` / `onAfter…`    |
| `applyToolResults`              | `onBeforeSessionApplyToolResults` / `onAfter…`       |
| `model.setModel` / `.setTarget` | `onBeforeSessionSetModel` / `onAfterSessionSetModel` |
| `snapshot`                      | `onBeforeSessionSnapshot` / `onAfterSessionSnapshot` |
| `restore`                       | `onBeforeSessionRestore` / `onAfterSessionRestore`   |
| `spawn` (and `fork`)            | `onBeforeSessionSpawn` / `onAfterSessionSpawn`       |
| `close`                         | `onBeforeSessionClose` / `onAfterSessionClose`       |

```ts
// Declarative — returns an Unsubscribe.
const off = session.hook({
  onBeforeSessionSend: (input) => ({ ...input, maxTicks: 4 }), // transform
});

// Per-verb imperative.
session.hooks.onBeforeSessionAppend((input) => audit.record(input));
```

A before-hook returning a value **transforms** the input; returning nothing observes; throwing vetoes and the operation aborts. After-hooks are symmetric over the output.

Because `spawn` and `close` are operations, policies that used to be inexpressible are one guard:

```ts
// "This app's agents may not spawn sub-agents."
app.guard({ sessionSpawn: () => ({ kind: "veto" as const, reason: "no-subagents" }) });

// Hold teardown open for a drain — but only on a genuine end.
session.hooks.onBeforeSessionClose((input) =>
  input.reason === "closed" ? waitForDrain() : undefined,
);
```

`close` carries its provenance. `{ reason: "closed" }` is a real session end and comes to rest on the `closed` status; `{ reason: "evicted" }` is what the app's idle sweep and memory cap pass, and it is transparent **paging** — it comes to rest on `hibernated`, the durable record and the timeline store survive, the session reconstructs on its next open, and app-level close handlers do not fire. Page-out and hangup take the same code path; the status and the record tell them apart, not the control flow.

> [!IMPORTANT]
> These operations are hookable but **not** wire-addressable. `SendInput` carries non-serializable per-call overrides (a live executor, an `AbortSignal`, tool registrations with real handlers), and `spawn` takes an agent root in and hands a live session out — none of that has a wire form. The gateway exposes the serializable porcelain (`session/send`, `session/respond_to_elicitation`) instead.

## Tracing a send

You bring the tracer; the framework bundles no OpenTelemetry dependency. Supply a telemetry `Layer` to `createApp` and every session runs its executions on the resulting runtime.

```tsx
import { createApp } from "@agentick/app/react";

// `telemetryLayer` is an Effect Layer you build yourself — e.g.
// `NodeSdk.layer(…)` from @effect/opentelemetry wrapping an OTLP exporter.
const app = await createApp(<Agent />, {
  model,
  telemetry: telemetryLayer,
  telemetryNamespace: "acme", // whitelabels the attribute keys — acme.op_id, …
});
```

Because one send is one fiber, nesting is free — no manual span threading. A single `session.send` yields:

```
loop:command:run-execution                 (the execution span — root)
├─ compiler:command:render-tree
├─ tool:command:replace-compiler-tools
├─ executor:command:project / run / …
└─ tool:command:dispatch                    (one per parallel tool call)
```

Every child's `parent_op_id` equals the execution's `op_id`. Without a Layer, spans emit against a no-op tracer and the run is otherwise identical.

Per-call identity rides the send, and stamps every span it touches — ticks, model calls, tool dispatches:

```ts
await session.send({
  messages,
  telemetry: { functionId: "triage", metadata: { tenant: "acme" } },
});
```

`functionId` defaults to the app's `name`, so a single-purpose app gets function-level traces with no configuration. The full observability model — attribute naming, usage and cost, the enrichment seams — is documented once, in [@agentick/runtime](../runtime).

## Listing and resuming sessions

Two structures, deliberately unmerged. The app's live registry maps ids to live sessions for routing; the durable store maps ids to `SessionRecord`s and is the resume index behind every "list my conversations" screen.

|          | Live registry        | `SessionStore`                                              |
| -------- | -------------------- | ----------------------------------------------------------- |
| Value    | the live session     | a `SessionRecord`                                           |
| Purpose  | routing, interaction | durable, queryable metadata                                 |
| Lifetime | dropped on close     | the superset — every non-ephemeral session, closed included |
| Read via | `app.getSession(id)` | `app.listSessions(query)` / `app.getSessionRecord(id)`      |

```ts
const recent = await app.listSessions({ status: "idle", updatedAfter: Date.now() - 86_400_000 });
await app.setSessionMeta("s:1", { title: "Release triage" });
```

A record is the **enumerate** half. The notify half is `session:channel:status`: every
status transition — including the ones a `close()` or an eviction sweep produces — is
published as a `SessionStatusFrame`, and the channel opens on the session's CURRENT
status. So a "list my conversations" screen seeds its rows from `listSessions` and keeps
them live from one subscription, and a client that reconnects mid-turn learns the session
is still running from frame one rather than from the next transition. `session.status`
reads the same fact synchronously. See `@agentick/client-core` for the client side.

```ts
interface SessionStatusFrame {
  sessionId: string;
  status: SessionStatus; // idle · running · input_required · hibernated · failed · closed
  executionId?: string; // the turn in flight, when there is one
  outcome?: "succeeded" | "failed" | "aborted";
}
```

`outcome` rides **only the transition that ends a run**, never the status value and never
the opening snapshot. That separation is the point: a turn that failed leaves a session
that is `idle` and perfectly usable, so folding the ending into the state would make a
healthy session render as broken. A UI raises a toast off the frame and draws the badge
off the status.

A running session blocked on a **pending ask** transitions to `input_required`,
and back to `running` when the last ask is answered — so "action required over there" is a
frame rather than something a UI can learn only by opening the session. Two things count
as an ask, and they are the same blocked state: an outstanding elicitation, and a
client-handled tool call the browser has not answered yet. Concurrent asks of either kind
are one blocked state; an ask raised outside an execution does not block an idle session;
and a turn that ends with asks outstanding still lands on `idle` — the ending beats the
block.

It is `input_required`, not `paused`, and the distinction is load-bearing: `paused` is
reserved for an operator explicitly stopping a session, and a UI has to tell "someone
stopped this" apart from "someone needs to answer something". The name matches the tasks
harness, where the same state one level down is already called `input_required`.

Records are written off the critical path — one write per status transition, never read back during render. `title`, `description` and `metadata` are yours: the framework stores them and is blind to their semantics. There is no `currentTick` on a record, because a tick is execution-local. `InMemorySessionStore` is the bundled default; any adapter that passes `runSessionStoreConformance` swaps in.

## Building a session yourself

The reference implementation takes its **substrate positionally** — journal, bus, inbox, typically inherited from the app — and everything else in an options bag. The positional shape keeps "substrate flows from the parent by default" visible at every call site.

```tsx
import { mergeRegistry, SEED_MODELS } from "@agentick/model";
import { SessionHarness } from "@agentick/session";

const session = new SessionHarness(journal, bus, inbox, {
  sessionId: "s:1",
  agent: <Agent />, // opaque — forwarded to the compiler at mount
  compiler: myCompiler,
  loop: myLoop,
  modelExecutor: myModelExecutor,
  toolExecutor: myToolExecutor,
  target: myTarget, // the default model; overridable per send
  defaultMaxTicks: 8,
  // The model registry is how the session resolves the active model's context
  // window for `useContextInfo`. Registries are federated — adapters export
  // fragments, you merge and inject.
  models: mergeRegistry(SEED_MODELS, { anthropic: { "claude-": myModelInfo } }),
});
```

For a session whose orchestration is fundamentally different — a test double, an alternative topology — `defineSession` builds a conforming session from callbacks. `send`, `snapshot` and the state-applicator triple the loop calls are required; every other verb defaults to throwing "not configured", and `timeline` / `knobs` / `state` default to no-op handles. One deliberate exception: `model.current` READS as `undefined` on a model-less callback session — a model-less session is legal, so the documented `if (session.model.current)` guard runs instead of crashing; only `setModel` / `setTarget` reject.

```ts
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { defineSession } from "@agentick/session";

const factory = defineSession({
  send: async () => scriptedHandle,
  snapshot: () => scriptedSnapshot,
  applyExecutorResult: async () => ({ appendedEntryIds: [] }),
  applyToolResults: async () => ({ appendedEntryIds: [] }),
  appendEntry: async () => ({ appendedEntryIds: [] }),
  timeline: customTimelineHandle, // override to expose real state
});

const session = factory({
  scopeId: "test-session",
  journal: new MemoryJournal(),
  bus: new LocalEventBus(),
  inbox: new LocalInbox(),
});
```

`elicitation`, `tasks` and `resources` are the only layers the factory builds eagerly on the supplied substrate when omitted. There is no bridge wiring — that plumbing belongs to `SessionHarness`.

## API

### `@agentick/session`

| Export                                                 | Purpose                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `SessionHarness` / `SessionHarnessOptions`             | The reference implementation and its construction options      |
| `defineSession` / `DefineSessionInput`                 | Callback-built session for custom or test topologies           |
| `SessionModelFacade` / `ModelSelectionHandle`          | What `session.model` is, and its type                          |
| `SetModelInput`                                        | The input a `setModel` / `setTarget` hook sees                 |
| `SessionRuntime`                                       | Per-session status / tick / usage projection (advanced)        |
| `InMemorySessionStore`                                 | The bundled in-memory session registry                         |
| `SessionRecord` / `SessionStore` / `SessionStoreQuery` | The durable record, its port, and its query — re-exported      |
| `SessionSubstrateParent`                               | Portable typing for substrate override factories — re-exported |

### `session.send(input)`

| Slot                                | Effect                                                             |
| ----------------------------------- | ------------------------------------------------------------------ |
| `messages`                          | Appended the moment they arrive; visible to the first render       |
| `output`                            | Live schema → validated `SendResult.data` (in-process only)        |
| `responseFormat`                    | Serializable structured-turn directive, applied every tick         |
| `tools`                             | Execution-scoped tool declarations, removed when the send ends     |
| `allowedTools`                      | Allowlist of canonical names the model may see                     |
| `onBusy`                            | `"steer"` joins an in-flight run; `"queue"` waits for idle         |
| `modelExecutor` / `target`          | Per-call model override — beats the session default                |
| `stream`                            | Per-call streaming; falls back to session, app, then capability    |
| `maxTicks` / `timeoutMs` / `signal` | Per-call bounds and cancellation                                   |
| `toolConcurrency`                   | `"unbounded"` (default) or a positive cap for a tick's tool calls  |
| `telemetry`                         | `{ functionId, metadata }` stamped on every span this send touches |
| `props` / `metadata`                | Component props for this run; adopter bag carried on the execution |

### Session verbs

| Method                          | Returns                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `status`                        | What the session is doing now — the live twin of the record    |
| `send(input)`                   | `Promise<SessionExecutionHandle>` — `.result` + `.events()`    |
| `spawn(input)`                  | A child session, or its handle when `send` is supplied         |
| `fork(input?)`                  | An unbound same-image child with the parent's state copied     |
| `reflect(input)`                | One more turn with an appended instruction; `output` → `data`  |
| `snapshot()` / `restore(input)` | Capture / reapply every snapshot-capable layer                 |
| `close(opts?)`                  | Teardown; `{ reason: "evicted" }` is paging, not an end        |
| `channel(name)`                 | Per-channel publish/subscribe plus correlated request/response |
| `interceptEscalation(handler)`  | Mediate a descendant's input request; returns an `Unsubscribe` |
| `use` / `guard` / `hook`        | Session-scoped interceptors and the command hook surface       |

### `@agentick/session/testing`

| Export                                                    | Purpose                                        |
| --------------------------------------------------------- | ---------------------------------------------- |
| `runKillResumeAcceptance` / `KillResumeAcceptanceOptions` | Kill-and-resume acceptance for a store backing |
| `runSessionStoreConformance` / `…Options`                 | Certify a `SessionStore` adapter               |

## Patterns

**Conversation.** [@agentick/timeline](../timeline) owns the log, the projection, and compaction. A session appends to it; `<Timeline/>` decides what folds into context.

**Parenting.** [@agentick/app](../app) constructs sessions, owns the live registry and the eviction policy, and injects the spawn context that makes `spawn`/`fork` work.

**Skills.** [@agentick/skills](../skills) runs a skill as a send primed with the skill's content, riding the structured-output path — `isolate: true` routes through `fork`.

**Wire.** [@agentick/gateway](../gateway) serves the serializable subset (`session/send`, elicitation responses, timeline history) and enforces the principal and scope rules a session carries.

**Observability.** [@agentick/runtime](../runtime) owns the interceptor tiers, the operation journal, and the telemetry model this package plugs into.

## Roadmap & known gaps

- **Session verbs are not wire-addressable.** They are hookable and journaled, but `SendInput` carries live handlers, an executor and a signal, so no wire command is declared. A designed serializable subset (`messages` + `maxTicks` + `stream`) is future work; the tool-dispatch verb is the natural first one to land.
- **The telemetry namespace whitelabels session-owned spans only.** App-shared layers carry their own default prefix. Reading the namespace from fiber context is pending; nesting is unaffected either way.
- **Inbox dispatch is narrow.** A session handles escalation and task-wake messages. Every other message type rejects.
- **The per-store cursor manifest is not built.** A `SessionRecord` has a slot reserved for per-store cursors, but nothing populates it, so a cross-store restore manifest is still a separate step from in-process `snapshot()`/`restore()`.
- **`setSessionMeta` targets live sessions only.** Editing a closed session's record needs a read-modify-write path against the store.
- **A queued send is invisible to clients.** `onBusy: "queue"` defers a racing send server-side and `"steer"` enqueues onto a per-execution queue, but neither is readable, so a UI cannot show what a send is waiting behind or cancel it. The first consumer to port onto `onBusy` had to drop its queued-messages bar. Closing it wants the `timeline:history` shape — a grant-gated declared read plus `added`/`removed` notifications — and a `dequeue` verb beside it.
- **`defineSession` has no inbox dispatch.** A callback-built session stores an escalation interceptor for protocol conformance but never consults it, and every inbox message rejects. Escalation and task-wake work on `SessionHarness` only.

## Verified by

- `@agentick/app` `src/__tests__/dry-run.spec.tsx` — the tree and the model input reach the caller, two dry runs leave `snapshot()` byte-identical, and `compile()` is the rung that needs no model.

- `src/__tests__/reflect.spec.tsx` — compaction folding through a real `timeline: { compact: rollingSummary(…) }` with its usage and progress frames, and the structured half: an `output` schema returning a validated object, the terminal tool being the only thing a reflection advertises and its choice forced, the native-`json_schema` target taking the directive with no tool at all, `ResponseValidationError` on a violating reply, `StructuredOutputIncomplete` on a reply that never calls the tool, and text-mode carrying neither tools nor directive.
- `src/__tests__/conformance.spec.ts` — the protocol conformance suite against a real journal, bus and inbox.
- `src/__tests__/extended-surface.spec.ts` — host-door `dispatch` including `ToolPermissionError`, the tool registry read surface, timeline append and `trailingInput`, channel publish/subscribe plus correlated request/response and its timeout, the knob handle, `spawn` routing through a spawn context and defaulting to the parent's own agent, the **spawn boundary pair** on the parent's stream (`spawn-start` carrying the child's session and execution ids plus the origin tool `callId` off the dispatch ctx, `spawn-end` carrying `isError`, both attributed to the parent's `executionId`; the unbound spawn form emits neither), **steering** (the join returns the in-flight handle and the loop answers the new input), two un-awaited sends collapsing to one execution, a send after settle running fresh rather than joining a dead handle, provenance and per-generation usage stamps, and `onBusy` steer-vs-queue including an aborted execution dropping an undrained steer; cancellation parity — `abort()` on an in-flight execution and a pre-aborted send `signal` both RESOLVE with `stopReason: "aborted"` rather than rejecting.
- `src/__tests__/streaming-handle.spec.tsx` — event order, dense monotonic sequence from 1, id/session/execution stamping, the streaming and non-streaming paths, and `.events()` yielding while `.result` resolves independently.
- `src/__tests__/structured-output.spec.ts` — terminal-tool injection and tail ordering, capability-aware strategy resolution (no native `json_schema` → the tool; neither tools nor `json_schema` → `responseFormat`), detection/stop/validated `data`, prose and a typed result in one tick, sibling tools dispatching first, timeline pairing letting the next send succeed, a tree-only `<Output>` producing validated `data` and `output_delivered`, the forced wrap-up tick, steer-proof stop, and the typed failures — `StructuredOutputIncomplete`, `ResponseValidationError`, `TerminalToolNameCollision` — plus send-beats-tree precedence and the explicit-steer conflict.
- `src/__tests__/structured-send.spec.ts` — `responseFormat` threaded to the executor over a tree declaration, retained when no send-level directive is given, applied on every tick of a multi-tick run, and the explicit-steer rejection whose `onBusy: "queue"` twin runs.
- `src/__tests__/tool-restriction.spec.ts` — only allowlisted tools reach the model, the unrestricted control, the dispatch door unaffected, additivity with `tools`, the terminal tool's exemption, and an empty allowlist resolving strategy as if no tools were mounted.
- `src/__tests__/model-facade.spec.ts` — `setModel` swapping the default (the next send uses the new executor), `setTarget` swapping only the target, `onBeforeSessionSetModel` vetoing, a `use` transform and a `guard` veto registered once still applying across an executor swap, the adapter overload via the injected builder, `ModelExecutorBuilderMissingError` without one, identical veto input for both overload forms, and per-send override precedence.
- `src/__tests__/session-hooks.spec.ts` — hook-name derivation agreement, `onBeforeSessionSend` and `onBeforeSessionAppend` firing on their verbs, and `onAfterSessionSend` seeing the handle.
- `src/__tests__/snapshot-command.spec.tsx` — the hook quartet, after-snapshot redaction, before-snapshot veto, the generic fold picking up a fake snapshot-capable extension and restoring it with zero session change, and the migration seam — applied on a version skew, `SnapshotVersionMismatch` without one.
- `src/__tests__/snapshot-restore.spec.tsx` — the compiler-level bridge fold: data cache, knob and state round-trip, rehydration onto a fresh mount, and survival of a JSON round-trip.
- `src/__tests__/timeline-durability.spec.ts` — hydration from an injected store before the first render, the flush barrier at execution end, and a buffered write failure rejecting the send with `TimelineWriteFailed` and landing `status: "failed"`.
- `src/__tests__/kill-resume.spec.ts` + `src/testing/kill-resume-acceptance.tsx` — the end-to-end resume acceptance run against memory, filesystem and Postgres backings, which also proves a `snapshot()` → `restore()` transplant into a fresh storeless session.
- `src/__tests__/session-store.spec.ts` — `InMemorySessionStore` under the full store conformance suite: round-trip, upsert, filtering by app / status / parent / recency, enumerate-all, delete, and prune-of-closed.
- `src/__tests__/escalation.spec.ts` — a task's `ctx.elicit` resolving terminally at its root session with the answer round-tripping and the task state machine flipping, the interactive-versus-detached guard, a real two-session chain forwarding by `parentSessionId`, interception in all three modes (answer without touching the client, deny by throwing, fall through), lineage order in the forwarded envelope, and a forked child's escalation composing the same chain across processes.
- `src/__tests__/task-wake.spec.ts` — an unobserved completion synthesizing a real journaled execution with task-wake provenance, an in-band result read consuming the wake so nothing is synthesized, and a wake arriving during a running execution steering into it.
- `src/__tests__/telemetry.spec.ts` — a send emitting a nested span tree on a tracer runtime, an async loop middleware not breaking the downstream tree, no telemetry runtime still working, and per-call `functionId` + metadata landing on every span the send touches (with nothing registered when telemetry is off).
- `src/__tests__/lifecycle-bridge.spec.tsx` — a real loop driving the whole `useOn*` family with `useContextInfo` yielding a live window and utilization; per-mount routing (two sessions on one shared loop — only the running one's hooks fire, and close unsubscribes); the settle-before-decide barrier (a knob mutated by an async tick-end effect is visible to the continuation decision); model-generate hooks from the real streaming command; and error projection phases for a failed executor terminal versus a hard tool throw.
- `src/__tests__/gates-integration.spec.tsx` — one gate registry behind both front ends, evaluated against a settled tick result, holding a real execution open to the tick cap, and a tree stop overriding a gate's continue in the same tick.
- `src/__tests__/model-bridge.spec.tsx` — a tree-declared per-tick model winning over the session default, and the fallback when the tree declares none.
- `src/__tests__/tree-interceptors.spec.tsx` — tree-side guards vetoing and admitting a model tool call, a deferred call resolved by an elicitation confirm in both directions, a transform reaching the model's actual projected input, per-mount isolation on a shared loop, freshness against the latest render's state, and unmounting mid-execution without a crash.
- `src/__tests__/layered-tools.spec.ts` — execution-scoped registration and removal, execution-over-session precedence, and session-scoped tools persisting across sends.
- `src/__tests__/channel-snapshot.spec.ts` — a channel opening on its current frame, an unowned channel reporting none, and a pending ask seeding the elicitation channel.
- `src/__tests__/status-channel.spec.ts` — a real execution bracketed by `running` → `idle` on `session:channel:status` (the running frame naming the turn in flight), `closed` on teardown, the status channel opening on the CURRENT status mid-execution, and `setStatus` calling back on a change but not on a same-value write; the ending riding the end transition for all three outcomes and never the snapshot; and blocked-on-input pausing a running session, resuming on the answer, leaving an idle session alone, and losing to the ending when a turn finishes with an ask outstanding.
- `src/__tests__/define-session.spec.ts` — the factory marker, delegation to the supplied callbacks, helpful errors from unconfigured verbs, and no-op handles resolving cleanly.
- `src/__tests__/usage-cost.spec.tsx` — the accounting record end to end: a two-model session partitioned into two `byModel` buckets whose usage sums to the flat total, an unidentified model keyed `unknown` rather than dropped, and the honesty rule in four forms (an unpriced session rolling up `partial` and never a zero `complete`, a mixed run's amount being the priced subset only, a foreign-currency tick counted unpriced in the total yet fully priced in its own bucket, and a session with no usage carrying no `cost` key at all). Plus `cost` + `model` stamped on the assistant entry (and absent, not zero, when unpriced), `SendResult` lifting the loop's own rollup, the turn-boundary record carrying the session-folded one, `byModel` + `cost` round-tripping a snapshot — including a restore that CLEARS a stale cost — and the wire projection: a priced tick's `tick` event carrying `cost` + `model` computed from the target's declared rates, an unpriced one carrying no `cost` key. The metrics mirror gets its own suite against a spy meter: a priced tick recording the cost histogram in micro-units labelled by model + currency, one observation per tick and per model rather than a pre-aggregate, an unpriced tick counting `unpriced` and recording NO cost observation, a mixed run emitting both, token histograms carrying only the kinds actually reported (an unreported kind emitting nothing, not a zero), a tick with no usage emitting nothing at all, labels holding to the bounded set — never `rateRef`, never a session / execution / tick id — the same mirror landing on the REAL loop path (the `.fx` twin, not just the public facade), and a session with no meter wired emitting nothing while its durable accounting lands unchanged.
- Spawn, fork and lifecycle operations are verified where both layers live, in [@agentick/app](../app): `spawn-hardening.spec.tsx` (the depth ceiling and `SpawnDepthExceededError`, `spawnPath` on the record / event scope / handle stream, parent close and abort disposing children), `fork.spec.tsx` (state copy, lineage, divergence), `lifecycle-operations.spec.tsx` (the linked spawn and child-create records, a guard vetoing at either layer, the bus-only close op and its `"evicted"` provenance from both the idle sweep and the memory cap), `set-model.spec.tsx` (the swap end-to-end through `createApp`), `session-principal-lifecycle.spec.tsx` (spawn and fork inheriting the principal), and `cascading-abort.spec.tsx` (`abort({ cascade: true })` over the live subtree deepest-first with nothing disposed, a plain abort leaving a session-scoped child alone but tearing down one spawned inside the aborted execution, and the `originExecutionId` edge `abortExecutionTree` walks). The wire gate engaging on the stamped principal is pinned in [@agentick/transport](../transport) (`session-principal.spec.ts`).
