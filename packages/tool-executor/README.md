# @agentick/tool-executor

**One boundary turns tool calls into tool results.** Whether a call comes from the model, from host code, from a browser client, or across the inbox from another process, it funnels through the same pipeline — resolve, validate, guard, confirm, invoke, stamp, emit.

That funnel is the bet. A tool call here is an **operation**, not a function call: it carries a stable id, a journaled `requested → before → terminal` envelope sequence, a provenance stamp naming the gate it entered through, and an interceptor fold that policy hangs off. Which is why dispatch is idempotent per tool-call id, cancellable from another process, and auditable after the fact — none of which `handlers[name](input)` can offer.

Most adopters never construct this. `createApp` builds one per session, and you reach it as [`session.tools`](#sessiontools--the-host-handle).

## Install

```bash
npm install @agentick/tool-executor
```

Subpaths: `/client` (browser-side handles), `/testing` (fixture + registration builder).

## Quick start

The `/testing` fixture is the shortest path to a live pipeline — it wires the substrate so you can dispatch immediately. In an app the wiring is `createApp`'s job and the same surfaces hang off `session`. Tools are authored with [@agentick/tool](../tool).

```ts
import { z } from "zod";
import { createTool } from "@agentick/tool";
import { createTestHarness, fakeRegistration } from "@agentick/tool-executor/testing";

const add = createTool({
  name: "add",
  description: "Add two numbers",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  exposure: ["model", "dispatch"], // reachable from both doors
  handlerRef: "h.add",
  handler: ({ a, b }) => `${a + b}`, // a bare string is sugar for one text block
});

const { harness } = await createTestHarness({
  tools: [fakeRegistration({ declaration: add.declaration, handlerRef: "h.add" })],
  // `handler` is optional on `createTool` — a handler-less tool is client-handled.
  handlers: [{ handlerRef: "h.add", handler: add.handler!, validator: add.validator }],
});

// The curated host handle — sync reads, async dispatch.
harness.tools.list({ exposure: "model" }); // → ToolInfo[]
await harness.tools.dispatch("add", { a: 1, b: 2 }); // → [{ type: "text", text: "3" }]

// The raw protocol call the loop makes on the model's behalf.
const result = await harness.dispatch({
  toolCallId: "c_1",
  name: "add",
  input: { a: 1, b: 2 },
  context: { via: "model", sessionId: "s_1" },
});
result.content; // [{ type: "text", text: "3" }]
result.executedBy; // "agentick" — executor-stamped, never handler-declarable
```

## Two doors, one pipeline

`context.via` names the door. Both doors run the same validation, the same confirmation gate, the same interceptors — and the door is observable to middleware, so a policy branches on it without inspecting private fields.

| Door              | Caller                                               | Journaled `origin` |
| ----------------- | ---------------------------------------------------- | ------------------ |
| `via: "model"`    | the loop, on a `tool_use` block                      | `model`            |
| `via: "dispatch"` | host code — `session.tools.dispatch(name, input)`    | `host`             |
| inbox message     | another process sends `tool:dispatch` to the address | `inbox`            |

`origin` names the **gate the operation entered through**, not the `via` a payload claims — an inbox-delivered dispatch is stamped by its delivering gate no matter what its body says. That is what makes the journal usable as an authorization record: who, through which gate, ran what.

`ToolDeclaration.exposure` decides which door reaches a tool; the wrong door is a `ToolPermissionError`.

| `exposure`              | Reachable from             |
| ----------------------- | -------------------------- |
| `["model"]`             | model only                 |
| `["dispatch"]`          | host only                  |
| `["model", "dispatch"]` | both                       |
| `["runtime"]`           | internal use; neither door |

> [!NOTE]
> Dispatch is idempotent on `toolCallId`: the operation id is derived from it, so re-dispatching the same call replays the cached terminal instead of running a side-effecting tool twice.

## `session.tools` — the host handle

The curated projection over the registry, shaped like its sibling handles. Reads are **sync** (an in-memory registry with a sync read surface holds a View), dispatch is async and carries host-door provenance.

```ts
session.tools.list({ exposure: "model" }); // ToolInfo[], precedence-resolved
session.tools.get("read_file")?.info; // per-tool handle + wire-safe projection
await session.tools.get("read_file")?.dispatch({ path: "notes.md" });
await session.tools.dispatch("read_file", { path: "notes.md" }); // host door
session.tools.has("ls"); // name, then alias
const off = session.tools.subscribeAll(() => rerender()); // registry topology
```

`ToolInfo` is the wire-safe row — `name`, `description`, `exposure`, `aliases?`, `annotations?`, `hasInputSchema`. The live `StandardSchemaV1` validator never crosses; power users who need it keep `session.toolExecutor`.

Subscriptions fire only from registration mutations (`register` / `unregister` / `removeBoundTools` / `replaceCompilerTools`), never from the hot dispatch read path — so subscribing costs nothing per call.

**Aliases.** `ToolDeclaration.aliases` gives a tool alternate dispatch names. Lookup is exact-name first, then an alias index built at register time, so `dispatch("ls", …)` reaches `list_directory` and an alias can never shadow a real tool.

**On handler ctx.** The same handle rides every dispatch as `ctx.tools` (#273), so a handler composes sibling tools — code-mode executors, orchestrator tools — through the identical journaled door and `"dispatch"` exposure gate as host code. Nothing weaker rides on ctx: a `["model"]`-only tool rejects from a handler exactly as it does from the host. Composition policy (recursion, budgets) belongs to guards at the dispatch seam. A sub-dispatch currently journals as a fresh host-door call; nesting under the calling tool's span is the open half of #273.

## Handler results — one currency, two failure channels

A handler returns a `string` (sugar for one text block), a `ContentBlock[]`, or an envelope. The three shapes are type-discriminable, so a wrong-shape return is a compile error rather than a silent reinterpretation.

```ts
import { createTool } from "@agentick/tool";
import { z } from "zod";

const readFile = createTool({
  name: "read_file",
  description: "Read a file",
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.object({ bytes: z.number() }),
  handler: async ({ path }) => {
    const found = await stat(path);
    if (!found) {
      // SOFT error: the dispatch RESOLVES with isError, the model reasons about it.
      return { content: `no such file: ${path}`, isError: true };
    }
    return {
      content: await read(path), // display half
      structuredContent: { bytes: found.size }, // validated against outputSchema
      metadata: { path }, // free-form, rides DispatchResult
    };
  },
});
```

- **Soft error** — `isError: true`. The handler ran; the result is error-flavoured but usable. The dispatch resolves.
- **Hard failure** — the handler throws. The dispatch **rejects** with a typed `ToolExecutorError`; no `DispatchResult` is produced.
- **`structuredContent`** is validated against the tool's `outputSchema` when both are present. A failure is a hard `ToolValidationError`, mirroring the input path. No `outputSchema` or no `structuredContent` ⇒ skipped.

`executedBy` and `durationMs` are stamped by the executor after the handler returns. An envelope that smuggles either — top-level or inside `metadata` — has them ignored; provenance is not handler-declarable. A layer that routes a tool elsewhere declares provenance once on the declaration instead: an MCP-backed tool carries `annotations.executedBy: "mcp:<serverId>"` so its result is attributed to that server, and plain local tools default to `"agentick"`.

Handlers may be sync, `async`, Effect-returning, or return a `TaskHandle` (see [task modes](#long-running-tools--task-modes)).

## The handler `ctx`

Handlers run at **dispatch**, separate from render. Everything session- or app-scoped arrives on `ctx`, resolved fresh from the live bridge — no stale render capture. The shape is identical whether the call arrives in-process or through an MCP-server projection, so handler code is portable across transports.

```ts
import type { ToolHandler } from "@agentick/tool-executor";

const handler: ToolHandler = async (input, { ctx, use }) => {
  ctx.toolCallId; // stable id — also the dispatch's idempotency key
  ctx.signal; // fires on caller abort, timeout, or inbox abort
  ctx.transport; // "in-process" here; "mcp" under an MCP-server projection
  ctx.task; // "auto" | "ref" | "inline" — resolved task mode for this call
  ctx.sessionId; // work-path identity, derived from the dispatching crossing
  ctx.setState("last", input); // readable from a tool's render()
  ctx.emit({ name: "session:channel:my_channel", payload: input });

  // Out-of-band diagnostics + liveness. Each emits ONE bus event, fire-and-forget.
  ctx.log("info", { step: "started" }, "my-tool");
  ctx.log.warning({ retrying: true }); // RFC-5424 severities as methods
  const bar = ctx.progress.begin({ total: 10 }); // token = this call; nothing to invent
  bar.advance(1, "reading");

  // A real, journaled, guard-reachable operation — without registering a command.
  const rows = await ctx.run("retrieval", () => search(input));

  // Substrate sugar — same spelling in-process and over MCP.
  await ctx.elicit?.text("Which branch?");
  await ctx.resource?.read("file:///notes.md");
  const handle = ctx.tasks?.submit(() => longJob());

  use.theme; // `use` is the render-captured escape hatch — tree-positional context only

  return { content: "ok", structuredContent: { rows: rows.length } };
};
```

`ctx.log` / `ctx.progress` are **always present**, never optional, and structurally bus-only — they are never journaled, so diagnostic volume cannot bloat the recovery spine. They are not sent to any wire directly either: projections subscribe and forward (an MCP server to `notifications/message` and `notifications/progress`, the agentick client to its log stream). Emit once, receive everywhere. A dying bus never blocks or fails the dispatch.

### Reporting progress

`ctx.progress` is a callable object, like `ctx.log`. Two doors:

```ts
// The everyday door. The token is the tool call id, the frames obey the four laws.
const bar = ctx.progress.begin({ total: files.length, message: "indexing" });
for (const f of files) bar.advance(1, f.name);
bar.done();

// The raw door. An explicit token and a hand-built frame.
ctx.progress(ctx.mcp!.progressToken!, { progress: 3, total: 10, message: "reading" });
```

Reach for `begin()` unless you have a specific reason not to: it mints the token from the dispatch, counts for you, clamps to the total, refuses to go backwards, and emits an opening frame so a UI shows the bar the instant the work starts. Reach for the raw door when the token came from somewhere else — echoing an MCP client's `_meta.progressToken` back under the id it correlates on — or when the handler already owns its own counting. Both doors emit the same single bus event per frame.

**If you know the denominator, say it. If you don't, never fake one.** `begin({ total })` renders a bar; `begin()` renders a spinner, and a spinner that tells the truth beats a bar that invents `total: 100` and jumps. When the denominator arrives mid-flight — a `content-length` that only comes with the response headers — `bar.total(n)` upgrades the spinner to a bar exactly once. It throws if called twice, because a total that moves makes every frame drawn before it a lie.

There is no `done` flag on the wire. `bar.done()` fills the bar; what actually closes it is the tool call resolving — the operation's lifecycle, which the client is already watching.

`ctx.run(name, fn)` sits deliberately between `ctx.trace` (a span, no journal) and a registered command (typed hooks, addressability): a journaled operation, parented under the dispatch, reachable by guards and string-keyed hooks, minted inline. It is **not** a memoized checkpoint — re-invoking re-runs `fn`. When `RunOptions` is too small, `ctx.runner.runOperation(op, body)` is the primitive undiluted, exposed as a run-only view.

### Optional slots — `ctxExtensions`

Capabilities that not every deployment mounts — a sandbox, say — reach handlers as typed `ctx` slots. The executor takes one opaque bag and spreads it; it imports no optional package and inspects no value.

```ts
new ToolExecutorHarness(scopeId, journal, bus, inbox, {
  handlerResolver,
  elicitation,
  ctxExtensions: { sandbox: theSandboxBridge }, // → every handler's ctx.sandbox
});
```

The **type** of `ctx.sandbox` comes from a `declare module "@agentick/spec"` augmentation of `ToolHandlerCtxExtensions` in the owning package; the **value** is threaded by the wiring layer and points at the live bridge. Guard optional slots with `?`:

```ts
const sandbox = ctx.sandbox?.get("primary");
const out = await sandbox?.exec({ command: "ls -la" });
```

Universal fields always win: the bag is spread first, so a colliding key can never shadow `toolCallId`, `signal`, `transport`, or the rest.

## Confirmation

`annotations.requiresConfirmation` routes a call through the elicitation gate before the handler runs. It is a seam, not a flag — `true` always confirms, a predicate decides per call on the **validated** input.

```ts
const transfer = createTool({
  name: "transfer",
  description: "Move money between accounts",
  inputSchema: z.object({ amount: z.number(), payee: z.string() }),
  annotations: { requiresConfirmation: (i) => (i as Args).amount > 100 },
  confirmationMessage: (i) => `Send $${i.amount} to ${i.payee}?`,
  confirmationPreview: async (i) => ({ fee: await quoteFee(i.amount) }),
  handler: async (i) => `sent $${i.amount}`,
});
```

- **`confirmationMessage`** — static string or a per-call function (sync or async) over the validated input + ctx. Becomes the elicitation `message`; unset falls back to `Approve tool "<name>"?`.
- **`confirmationPreview`** — awaited at the gate and merged under `metadata.preview`, leaving `toolUseId` / `toolName` / `arguments` intact, so a client renders a diff or a cost breakdown without a bespoke channel.

The wire envelope is an ordinary elicitation with `hints.kind === "tool_confirmation"`. Approval requires `accepted` **and** `reply.approved === true`; every other outcome — declined, cancelled, aborted, schema violation, accepted-with-`approved: false` — becomes a denial-shaped result (`isError: true`, `executedBy: "agentick"` because the tool never ran). `reply.always` marks the tool session-allowed so later calls skip the gate; `reply.modifiedArguments` is re-validated before the handler runs. A wait past the bound is `ToolConfirmationTimeoutError`.

> [!WARNING]
> **Not a security boundary.** `requiresConfirmation`, `guardDispatch`, and `exposure` are policy seams — they shape what the model is offered and when a human approves. A call that clears the gate runs with the host process's full permissions, and inspecting command strings inside a predicate is advisory UX, not containment (pipes, base64, and heredocs defeat textual filtering). The confinement boundary is OS-level and lives in the sandbox provider.

## Abort, timeout

`abort({ toolCallId, reason? })` fires the matching `AbortController`; the dispatch rejects with `ToolAbortedError`. Aborting an unknown id is a safe no-op.

```ts
await tools.abort({ toolCallId: "c_1" }); // in-process
```

It is a **declared command** (`tool:abort`), not a plain method — on the reference implementation and on `defineToolExecutor` executors alike. So an external actor (a session on user-escape, another cluster node) cancels a call by sending `{ type: "tool:abort", payload: { toolCallId } }` to the executor's `tool:{scopeId}` address; the command registry routes it, no hand-rolled inbox switch. The handler fires the controller synchronously and journaling wraps it, so cancellation is never deferred by the phase contract.

Timeout precedence, highest first: `DispatchInput.timeoutMs` → `annotations.timeout` → the construction-time `defaultTimeoutMs`. A trip aborts the call with `ToolTimeoutError`. Confirmation waits have their own ladder: `annotations.confirmationTimeoutMs` → `DispatchInput.confirmationTimeoutMs` → `defaultConfirmationTimeoutMs`.

## Long-running tools — task modes

A handler that returns a `TaskHandle` (from `ctx.tasks!.submit(...)`) resolves one of two ways, from the tool's `annotations.taskSupport` combined with the caller's `DispatchInput.task` (default `"auto"`).

- **Pattern A — await transparently.** The executor awaits `handle.result` and returns its blocks. The model never sees a task id. Aborting the dispatch cancels the in-flight task rather than orphaning it.
- **Pattern B — return a ref.** The executor returns immediately with a `{ type: "task_ref", taskId, status, … }` block. The model then drives the task through the `task_*` tools.

| `task` \ `taskSupport` | `"unsupported"`             | `"supported"` | `"required"`                |
| ---------------------- | --------------------------- | ------------- | --------------------------- |
| `"ref"`                | `ToolTaskModeConflictError` | Pattern B     | Pattern B                   |
| `"inline"`             | Pattern A                   | Pattern A     | `ToolTaskModeConflictError` |
| `"auto"` (host door)   | Pattern A                   | Pattern A     | Pattern A                   |
| `"auto"` (model door)  | Pattern A                   | Pattern A     | Pattern B                   |

Conflicts are rejected **before the handler runs**, so a handler never observes a contradictory combination.

## Layered registration

The same tool name can be registered from several seams at once — one entry per binding slot. `compileForTick` resolves the per-tick model-visible set: filter first, then highest-precedence binding wins per name.

| Rank (low → high) | Binding                         |
| ----------------- | ------------------------------- |
| `runtime`         | ad-hoc / fixture registrations  |
| `gateway`         | process-wide config             |
| `app`             | `createApp({ tools })`          |
| `session`         | `createSession({ tools })`      |
| `execution`       | `SendInput.tools`               |
| `client`          | a browser client's declared set |
| `compiler`        | the rendered tree               |

An `extension` binding takes the rank of the level it was installed at. `PRECEDENCE_RANK`, `precedenceOf`, `bindingKey`, and `sameBindingKey` are exported as data, not buried in a switch.

Filtering happens **before** precedence, so a high-rank registration that fails the filter cannot shadow a lower-rank one that passes.

> [!IMPORTANT]
> `compileForTick` also carries a serialization guarantee: **execution-scoped winners are stably partitioned to the tail**, after every non-execution winner. Tools serialize at the head of the provider prompt, so a per-execution binding would otherwise perturb the prefix. Keeping the stable tree/session tools at the head means a cache breakpoint on that prefix keeps hitting — only the tail is new.

Registration is idempotent per binding slot on identical shape; a _different_ shape in the same slot is `ToolAlreadyRegistered`. Same name, different binding, just adds a sibling.

**Scoped bindings.** `withScope` composes register-each + cleanup around an async body — the cleanup runs on return, throw, or abort:

```ts
import { withScope } from "@agentick/tool-executor";

const out = await withScope(
  toolExecutor,
  { scope: "execution", executionId },
  input.tools ?? [],
  () => loop.runExecution(executionId),
);
```

## Guards, middleware, hooks

Three seams, three jobs:

```ts
import { Effect } from "effect";

// Admission — decide whether the dispatch runs at all. Effect-native: the
// verdict is decided in-fiber, before the body.
const off = tools.guardDispatch((input) =>
  Effect.succeed(
    input.name === "rm_rf"
      ? { kind: "veto" as const, reason: "blocked" }
      : { kind: "proceed" as const },
  ),
);

// Wrapping — see input and result, add timing/retry/logging.
tools.fx.use((input, next) => next(input));
```

`guardDispatch` returns a verdict: `proceed` (or void), `veto` (terminal `vetoed`), `replace` (short-circuit with a supplied result), `defer`. Multiple guards compose by compose-order — outermost decides first. It is the tool-typed name for the universal guard seam; it decides **op admission**, distinct from the loop-continuation `gate`.

Because `dispatch` is a declared command, it also mints typed lifecycle hooks registered at any scope that folds down to it (`createApp({ hooks })`, `createSession({ hooks })`):

| Hook                   | Fires         | Receives / returns                                                                       |
| ---------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `onBeforeToolDispatch` | pre-dispatch  | `DispatchInput` — transform the call, or throw to veto it                                |
| `onAfterToolDispatch`  | post-dispatch | the full `DispatchResult` — so an after-hook cannot silently strip `isError` or metadata |

### The Effect edge

`.fx` is the composable twin of the Promise surface — reach for it when you want a tool call inside one fiber tree rather than at a `runPromise` root.

```ts
import { Effect } from "effect";

const program = Effect.gen(function* () {
  yield* tools.fx.replaceCompilerTools({ mountId, registrations });
  const decls = yield* tools.fx.compileForTick({ exposure: "model" });
  const res = yield* tools.fx.dispatch(dispatchInput);
  return { decls, res };
});
```

The twin preserves the door → origin mapping, and typed failures (a bad compiler-slice binding, for instance) land catchable on the error channel rather than crashing the fiber. `dispatch()` / `compileForTick()` / `replaceCompilerTools()` are the derived facades.

## Client-handled tools

A declaration with **no `handlerRef`** is client-handled: there is no server handler, and the executor either relays the call to a client or resolves it with a computed default. Input is still validated and the confirmation gate still runs. (A `handlerRef` that is present but unresolvable stays a hard `ToolHandlerMissing` — that is a bug, not a client tool.)

```ts
// Server side: a handler-less createTool IS the client-tool declaration.
const openFile = createTool({
  name: "open_file",
  description: "Open a file in the user's editor",
  inputSchema: z.object({ path: z.string() }),
  annotations: { requiresResponse: true, responseTimeoutMs: 30_000 },
  defaultResult: (i) => [{ type: "text", text: `could not open ${i.path}` }],
});
```

| `annotations.requiresResponse` | Behaviour                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `true`                         | The dispatch **suspends**, relays the call, and resumes with the client's result (`executedBy: "client"`). On timeout it falls back to `defaultResult`, else `ToolCallTimeoutError`. |
| falsy (default)                | Resolves **immediately** with `defaultResult` (or a canned success block) and emits a one-way notification so the client still runs/renders the tool.                                |

`defaultResult` is a seam like the confirmation ones: static blocks or a per-call function on the validated input + ctx, evaluated at the resolve site — so a client tool can compute a call-specific fallback. Either way the result re-enters the loop through the unchanged `DispatchResult → tool_result` path.

`executedBy` on this path is a hardcoded `"client"` — it never reads `annotations.executedBy`, which is absent from the wire annotation subset and stripped at the fold. A client cannot spoof provider or MCP provenance even with a raw payload.

### The browser side — `@agentick/tool-executor/client`

Importing the subpath self-assembles two handles on the session. `clientToolCalls` is the inbound call feed; `tools` is the registry projection. Different slot, different concern.

```ts
import "@agentick/tool-executor/client";

const calls = client.session(sessionId).clientToolCalls;

// Declare this client's tool set — a whole-slice REPLACE. Reconnect = re-declare.
await calls.set([openFileDecl, getWeatherDecl]);

// Route inbound calls to handlers and auto-respond.
const stop = calls.route({
  open_file: (input) => read((input as { path: string }).path),
  get_weather: (input) => `sunny in ${(input as { city: string }).city}`,
});

// Answer confirmation prompts.
calls.confirm((req) => !req.toolName?.startsWith("rm"));
```

A UI that draws its **own** confirmation dialog reads the request off `session.elicitations` with `toolConfirmation(elic)` instead of handing the decision to `confirm(policy)`. It is the same reader `confirm` uses, so a dialog gets every field the gate stamped — including the `confirmationPreview` — and `undefined` narrows away everything that is not a confirmation:

```ts
import { toolConfirmation } from "@agentick/tool-executor/client";

for (const elic of session.elicitations.list()) {
  const req = toolConfirmation(elic);
  if (!req) continue; // an MCP ask, a sandbox permission — not ours
  const ok = await showDialog(req.toolName, req.arguments, req.message, req.preview);
  await (ok ? elic.accept({ approved: true }) : elic.decline());
}
```

Do not run this **and** `confirm(policy)` — both answer the same correlation id.

`route` answers a throwing handler with an error result — a suspended call is never left hanging. Fire-and-forget relays carry no correlation id, so they never enter `list()`, but `route` still dispatches their handler.

The pending set is snapshot-first: the executor publishes every outstanding `requiresResponse` call as the channel's opening frame, so a client that connects **mid-call** finds it in `list()` and can answer it, instead of the call hanging until timeout.

```ts
calls.list(); // pending calls, each with a bound .respond(result)
calls.get(correlationId);
await calls.respond(correlationId, "done"); // by-id; rejects unknown/answered ids
calls.subscribe(() => rerender()); // zero-arg store contract
```

`respondToToolCall(client, sessionId, correlationId, result)` is the free by-id escape hatch for code holding a bare correlation id outside the pending set.

The registry projection is RPC-backed — there is no tools delta channel, so `list()`/`get()` read a snapshot seeded by an eager poll:

```ts
const tools = client.session(sessionId).tools;
tools.subscribe(() => renderPalette(tools.list())); // fires when the seed lands
tools.list(); // ToolInfo[] — empty for one round-trip, then filled
await tools.refresh({ exposure: "model" }); // re-poll on demand
await tools.dispatch("read_file", { path: "notes.md" }); // host door, over the wire
```

The snapshot fills itself: the handle polls once on construction and fires `subscribe` when the answer lands, so the right shape is to bind both — render what `list()` has, re-render on change — and there is nothing to await and no boot-time `refresh()` to issue. `refresh()` is for invalidating a snapshot you already have. A first poll that fails leaves the snapshot empty rather than half-filled; the next mutation's re-fetch or an explicit `refresh()` recovers it. Only the FIRST page of the wire read seeds the snapshot; a catalog past one page is walked by calling `session/list_tools` with a cursor directly.

The wire methods behind all of this:

| Wire method                    | Params                                 | Effect                                                                                              |
| ------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `session/list_tools`           | `{ sessionId, exposure?, cursor? }`    | One page of the registry projection: `{ tools, nextCursor? }`. `nextCursor` absent ⇒ last page.     |
| `session/set_client_tools`     | `{ sessionId, declarations }`          | Clears the `{ scope: "client", sessionId }` slice, then registers the new set. Returns `{ count }`. |
| `session/respond_to_tool_call` | `{ sessionId, correlationId, result }` | Resumes the suspended dispatch. Idempotent — an unknown or answered id is a silent no-op.           |

`session.tools.list(query)` in-process is unpaginated — a bounded snapshot. Pagination is a wire concern, so the cursor exists only on the wire read.

The client slice is its own binding, held distinct from `{ scope: "session" }`, so replacing it never clobbers app-declared tools, and session close reaps it.

> [!NOTE]
> The client slice is keyed by `sessionId`, not by connection — every client on a session shares one slice, so concurrent `set` calls are last-write-wins over the whole set. Coordinating which client owns the tools is the app's concern.

## Presentation and model narration

"What is this call doing?" has two axes — **identity** and **activity** — from up to four sources. The executor surfaces them as four distinct fields on `DispatchResult.presentation` and collapses none of them; a client composes identity from `title ?? name` and activity from `narration ?? summary`, or shows them separately.

| Field       | Source                                          | Axis                        |
| ----------- | ----------------------------------------------- | --------------------------- |
| `name`      | the raw tool id — always set                    | identity (fallback)         |
| `title`     | `annotations.title` (`"Write file"`)            | identity                    |
| `summary`   | `annotations.displaySummary`, resolved per call | activity, the author's take |
| `narration` | the model's own `_summary`                      | activity, the model's take  |

`displaySummary` is a seam like the confirmation ones — a static string or a per-call function on the validated input + ctx.

`_summary` is a **reserved** optional field the model projector injects into every model-facing tool schema, letting the model say in one sentence what a call is doing — the sentence that lights a spinner. The executor **strips it from the raw input before validation** (shallow copy; the caller's object is never mutated), so it never reaches the author's schema, the handler, or the persisted `tool_result`. Stripping is model-door only. A tool whose own schema declares `_summary` opts out implicitly; `narrate: false` opts out explicitly.

> [!WARNING]
> Injecting `_summary` into every tool schema and having the model emit a sentence per call is real input **and** output token cost on every tool-using tick. It defaults on; turn it off where the narration isn't worth it:
>
> ```ts
> const app = await createApp(Agent, { model, compiler, narrate: false }); // app-wide
> await app.createSession({ narrate: false }); // per session
> createTool({ name, description, narrate: false }); // per tool
> ```

## Custom executors

`defineToolExecutor` satisfies the protocol from a callback bundle, for a remote tool service or alternate registry storage.

```ts
import { defineToolExecutor } from "@agentick/tool-executor";

const toolExecutor = defineToolExecutor({
  async dispatch(input) {
    const out = await remoteToolService.run(input.name, input.input);
    return {
      toolCallId: input.toolCallId,
      name: input.name,
      content: [{ type: "text", text: out.text }],
      // isError: true for a soft/domain error; throw for a hard failure.
    };
  },
});

const app = await createApp(Agent, { model, compiler, toolExecutor });
```

> [!NOTE]
> The factory goes in the `toolExecutor` slot — that slot configures the **executor**. `createApp({ tools })` is the layered tool **declaration** list, a different thing.

`dispatch` is required. `list` / `register` / `unregister` / `abort` / `compileForTick` / `replaceCompilerTools` / `removeBoundTools` are optional and fall through to a bundled `InMemoryToolRegistry`. The substrate phase contract, the `tool:dispatch` / `tool:abort` command declarations, and door → origin provenance apply identically. The validation pipeline and confirmation gate are **not** replicated — subclass `ToolExecutorHarness` if you need those.

## Testing

```ts
import { createTestHarness, fakeRegistration } from "@agentick/tool-executor/testing";

const { harness, bus, journal, elicitation, tasks } = await createTestHarness({
  tools: [fakeRegistration({ declaration, handlerRef: "h.echo" })],
  handlers: [{ handlerRef: "h.echo", handler: (i) => JSON.stringify(i) }],
  ctxExtensions: { sandbox: stubSandbox }, // exercise an optional ctx slot
});
```

`createTestHarness` wires an in-memory substrate plus a real elicitation and tasks harness instance on the **same** substrate — so a bus subscription sees envelopes from all three and a test can answer its own confirmation prompts. Everything is `ready` when it resolves. `fakeRegistration` fills the registration defaults (`binding` defaults to `{ scope: "runtime" }`).

The reference implementation is additionally driven through the shared `runToolExecutorConformance` suite.

## API

### `@agentick/tool-executor`

| Export                                                               | Purpose                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ToolExecutorHarness`                                                | The reference implementation, for direct construction                     |
| `defineToolExecutor`                                                 | Callback-style factory — bring a `dispatch` callback                      |
| `InMemoryToolRegistry`                                               | Multi-binding registry with per-tick precedence resolution                |
| `InMemoryHandlerResolver`                                            | `handlerRef → { handler, validator }` lookup table                        |
| `createToolsHandle` / `toToolInfo`                                   | The `session.tools` factory and its wire-safe projection                  |
| `withScope`                                                          | Bind declarations for the duration of an async body; cleanup in `finally` |
| `permissiveValidator` / `fromStandardSchema`                         | Accept-anything, and a Standard Schema v1 adapter (Zod, Valibot, …)       |
| `viaToOrigin`                                                        | The door → operation-origin mapping, as data                              |
| `TOOL_CALL_CHANNEL` / `..._FQN` / `..._REQUEST_SCHEMA`               | The client-tool wire contract                                             |
| `PRECEDENCE_RANK` / `precedenceOf` / `bindingKey` / `sameBindingKey` | The precedence ladder, as data (from `./registry.js`)                     |

Types: `ToolExecutorHarnessOptions`, `HandlerResolver`, `HandlerEntry`, `HandlerChannelSeed`, `ToolHandler`, `ToolHandlerCtx`, `Validator`, `ValidatorResult`, `PendingToolCall`, `ToolCallRequestPayload`, `ToolCallResponse`, `ToolCallSnapshotFrame`. The handler and validator types live in [@agentick/spec](../spec) so the authoring layer consumes them without depending on this runtime package; they are re-exported here.

### Construction options

| Option                                              | Purpose                                                    |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `handlerResolver` (required)                        | Resolves `handlerRef` to a handler + validator             |
| `elicitation` (required)                            | Backs the confirmation gate and `ctx.elicit`               |
| `tasks` / `resources`                               | Surface `ctx.tasks` / `ctx.resource`                       |
| `initialTools`                                      | Registered synchronously, before the inbox accepts traffic |
| `defaultTimeoutMs` / `defaultConfirmationTimeoutMs` | Fallback wait bounds                                       |
| `ctxExtensions`                                     | Opaque bag spread onto every handler's `ctx`               |
| `channelPublisher`                                  | Routes `ctx.emit(seed)` to the session channel bus         |
| `telemetryProvider` / `defaultMetricLabels`         | Light `ctx.trace` / `ctx.metrics`                          |
| `inheritedInterceptors` / `interceptorParent`       | Fold ancestor guards, middleware, and hooks onto dispatch  |

### Typed errors

`ToolNotFoundError` · `ToolPermissionError` · `ToolHandlerMissing` · `ToolValidationError` · `ToolHandlerError` · `ToolAbortedError` · `ToolTimeoutError` · `ToolConfirmationTimeoutError` · `ToolCallTimeoutError` · `ToolTaskModeConflictError` · `ToolAlreadyRegistered`. All from [@agentick/spec](../spec); all hard failures reject the dispatch.

### `@agentick/tool-executor/client`

| Export                     | Purpose                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `session.clientToolCalls`  | Registered on import: pending-call feed + `set`/`route`/`confirm`/`respond` |
| `session.tools`            | Registered on import: registry projection + `dispatch`/`refresh`            |
| `clientToolCallsHandle`    | The headless factory behind the feed                                        |
| `toolsHandle`              | The headless factory behind the registry projection                         |
| `toolConfirmation`         | Reads an elicitation as a `ConfirmRequest`; `undefined` if it isn't one     |
| `respondToToolCall`        | By-id reply escape hatch                                                    |
| `TOOL_CALL_CHANNEL`/`_FQN` | The channel names, for a consumer subscribing itself                        |

Types: `ClientToolCall`, `ClientToolCallHandle`, `ClientToolCallsHandle`, `ClientToolHandler`, `RouteClientToolsOptions`, `ToolsClientHandle`, `ConfirmPolicy`, `ConfirmRequest`, `PendingToolCall`, `ToolCallRequestPayload`, `ToolCallResponse`, `ToolCallSnapshotFrame`. The channel names and wire shapes are re-exported here so a browser bundle never has to reach for the root barrel — which would drag the executor runtime in with them.

### `@agentick/tool-executor/testing`

`createTestHarness` (the bundle above) and `fakeRegistration` — see [Testing](#testing).

## Patterns

**Authoring.** [@agentick/tool](../tool) owns `createTool` and the tool catalog; [@agentick/compiler-react](../compiler-react) adds the `<Tool>` component and captures `use:` deps at render for the `deps` bag.

**Shapes.** [@agentick/spec](../spec) owns `ToolDeclaration`, `ToolAnnotations`, `DispatchInput`/`DispatchResult`, the result currency and its `normalizeToolResult`, `ToolsHandle`, and the client-tool wire types including `toClientToolRegistration`.

**Long-running work.** [@agentick/tasks](../tasks) owns `TaskHandle` and the `task_*` model tools that drive Pattern B refs.

**Confirmation transport.** [@agentick/elicitation](../elicitation) owns the gate's request/response channel and the `ctx.elicit` sugar.

**Wire.** [@agentick/gateway](../gateway) serves `session/set_client_tools`, `session/respond_to_tool_call`, `session/list_tools`, and `session/dispatch`.

## Roadmap & known gaps

- **Callback-executor inbox surface.** `tool:abort` and `tool:dispatch` auto-route on a `defineToolExecutor` executor via the command registry. Any _other_ inbox message type still lands on `HandlerError` — declare it as a command to wire it.
- **`taskSupport: "supported"` negotiation.** The `"supported"` branch resolves conservatively (Pattern A outside the model-required path). Per-call capability negotiation isn't built.
- **Custom-registry parity.** `defineToolExecutor` replicates storage callbacks but not the validation pipeline or confirmation gate; those need a subclass.
- **Per-connection client slices.** The client tool slice is keyed by session, so multiple clients on one session are last-write-wins. Sub-slices keyed by connection are a future extension.
- **Snapshot fold granularity.** The opening `tool_call` snapshot frame carries no top-level `toolCallId`/`name`, so a hand-rolled per-call fold that keys on those skips it; the bundled client handle consumes it correctly.

## Verified by

- `src/__tests__/conformance.spec.ts` — drives the shared `runToolExecutorConformance` suite.
- `src/__tests__/harness.spec.ts` — dispatch happy path with validated input and `use` deps, idempotency (a repeat `toolCallId` replays the terminal, the tool runs once), the error paths (`ToolNotFoundError`, wrong door, missing handler, validation, handler throw), abort by call, by caller signal, by timeout, by inbox `tool:abort`, unknown-id no-op, registry surface + exposure filter, `setState`/`getState`, door → origin stamping on the journaled envelope, inbox dispatch-by-name, `replaceCompilerTools` atomicity, and `compileForTick` precedence.
- `src/__tests__/tool-result-currency.spec.ts` — string / array / envelope currency, `isError` (soft, resolves) vs throw (hard, rejects), `structuredContent` × `outputSchema` validation, and that a smuggled `executedBy`/`durationMs` is ignored top-level and inside `metadata`.
- `src/__tests__/registry.spec.ts` + `layered-tools.spec.ts` — multi-binding storage, idempotency and shape-conflict, every precedence rung, filter-before-precedence, `replaceCompilerSlice`, `removeWhere`, and the execution-tail serialization guarantee.
- `src/__tests__/tools-handle.spec.ts` — `session.tools`: `ToolInfo` projection, exposure filter, name-then-alias `get`/`has`, canonical-name dispatch binding, and the two subscription shapes.
- `src/__tests__/confirmation.spec.ts` + `confirmation-seams.spec.ts` — approve / deny / declined / `always` / `modifiedArguments` / abort / timeout, the wire envelope's `hints.kind` and metadata, `confirmationMessage` (string, sync and async function, default-prompt regression), `confirmationPreview` merging under `metadata.preview`, callable `defaultResult`, and dispatch by alias.
- `src/__tests__/client-tools.spec.ts` + `pending-snapshot.spec.ts` — async `requiresConfirmation` predicates, `requiresResponse` suspend/relay/resume, fire-and-forget notify, timeout fallback and `ToolCallTimeoutError`, bare-string relay normalization, the unspoofable `executedBy: "client"`, unknown-correlation no-op, the present-but-unresolvable `handlerRef` regression guard, gating before relay, and the mid-call snapshot frame.
- `src/__tests__/client-tool-router.spec.ts` + `client-tool-confirm.spec.ts` + `client-tool-calls.conformance.spec.ts` + `src/client/__tests__/tools-handle.spec.ts` + `session-tools.spec.ts` — the router (correlated relay → respond, unknown → error, throw → error, custom `onUnknown`, fire-and-forget → no respond), confirm policies, `toolConfirmation` narrowing (non-confirmation → `undefined`, `preview` surviving the mapping, absent fields omitted), the client handle contract, and the registry projection (eager poll, the seed notifying subscribers so no boot-time `refresh()` is needed and settling empty on a failed poll, `refresh({ exposure })`, `dispatch` wire shape, zero-arg `subscribe`, no slot collision).
- `src/__tests__/dispatch-task-mode-matrix.spec.ts` + `task-handle.spec.ts` — every cell of the task-mode matrix, `ctx.tasks` wiring, Pattern B continuing after the ref returns, and abort propagation into the in-flight task.
- `src/__tests__/ctx-extensions.spec.ts` + `ctx-run.spec.ts` + `ctx-trunk-derivation.spec.ts` + `signals.spec.ts` + `signal-fire-and-forget.spec.ts` — opaque extension slots (freshness, absence, universal-field collision safety); `ctx.run` minting a journaled op parented under the dispatch, hook-observable and guard-vetoable, plus `ctx.runner` as a run-only view; the dispatch ctx carrying the crossing's real work-path ids; and `ctx.log` / `ctx.progress` emit shape, scope, and survival of a dying bus — including `ctx.progress.begin()` reporting on the dispatch's own tool call id, every determinate frame carrying `total`, and an indeterminate one never carrying it.
- `src/__tests__/middleware-and-hooks.spec.ts` + `command-hooks-augmentation.spec.ts` + `fx-dispatch.spec.ts` — middleware wrapping and compose order, `guardDispatch` verdicts, unsubscribe, the typed hook names agreeing with the runtime derivation, and the `.fx` twins (composable Effects, Promise facades, door → origin preservation, single-fiber nesting, catchable binding mismatch).
- `src/__tests__/define-tool-executor.spec.ts` + `with-scope.spec.ts` + `validator.spec.ts` + `handler-resolver.spec.ts` — the callback factory (marker, default and custom registry callbacks, inbox `tool:abort`, dispatch-as-command parity, bus envelopes), scoped binding cleanup on return and throw, the validators, and the resolver.
