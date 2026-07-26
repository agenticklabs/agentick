# @agentick/elicitation

**ElicitationHarness — substrate-level "ask the user for a structured
response" primitive.**

Every part of the framework that needs a synchronous user-in-the-loop
step — tool confirmation, MCP `elicitation/create`, agent-side asks,
approval workflows — funnels through this one named protocol so the
wire envelope, channel name, correlation engine, and timeout/abort
semantics live in exactly one place.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## Purpose

Promotes the request/response correlation pattern (previously buried
inside `tool-executor`'s confirmation gate) into a first-class harness.
It is the substrate primitive that backs:

- **Tool confirmation** (`ToolDeclaration.annotations.requiresConfirmation`)
- **MCP elicitation** (`elicitation/create` — server asks user mid-call)
- **Generic agent-side asks** ("which file do you want me to edit?")
- **Approval gates** in any custom harness

If a harness needs a typed user answer with timeout, abort, and schema
validation, it calls `bridges.elicitation.elicit(...)` — it does NOT
roll its own channel + payload + correlation engine.

## Quick start

```ts
import { withElicitation, ELICITATION_CHANNEL_FQN } from "@agentick/elicitation";
import { jsonSchema } from "@agentick/spec";

const app = createApp(MyAgent, {
  extensions: [
    withElicitation(),
    // ...other extensions
  ],
});

// Inside any harness wired with the elicitation bridge:
const result = await bridges.elicitation.elicit(
  {
    message: "Approve calling `delete_file` on /tmp/draft.txt?",
    schema: jsonSchema<{ approved: boolean }>(
      {
        type: "object",
        properties: { approved: { type: "boolean" } },
        required: ["approved"],
      },
      {
        validator: (raw) =>
          raw !== null &&
          typeof raw === "object" &&
          typeof (raw as { approved?: unknown }).approved === "boolean"
            ? { value: { approved: (raw as { approved: boolean }).approved } }
            : { issues: [{ message: "missing required boolean `approved`" }] },
      },
    ),
    hints: { kind: "tool_confirmation", confirmLabel: "Approve" },
    metadata: { toolName: "delete_file", input: { path: "/tmp/draft.txt" } },
  },
  { timeoutMs: 30_000, signal: ctrl.signal },
);

switch (result.outcome) {
  case "accepted":
    if (result.value.approved) runTool();
    else explainDenial();
    break;
  case "declined":
  case "cancelled":
    explainDenial(result.reason);
    break;
  case "failed":
    switch (result.failure.kind) {
      case "timeout":
        cleanup();
        break;
      case "aborted":
        abortPath(result.failure.reason);
        break;
      case "schema_violation":
        logSchemaIssues(result.failure.issues);
        break;
    }
    break;
}
```

## Result shape

`elicit(...)` NEVER throws. Every terminal — user-driven, transport,
timing, or schema — lands on a single discriminated union:

```ts
type ElicitationResult<T> =
  | { outcome: "accepted"; value: T }
  | { outcome: "declined";  reason?: string }
  | { outcome: "cancelled"; reason?: string }
  | { outcome: "failed";    failure: ElicitationFailure };

interface ElicitationFailure {
  kind: "timeout" | "aborted" | "schema_violation";
  reason?: string;
  issues?: ReadonlyArray<{ path?: ...; message: string }>;  // only when kind === "schema_violation"
}
```

`accepted | declined | cancelled` mirror MCP 2025-11-25 elicitation
outcomes verbatim. `failed` collapses the three system-driven failure
modes the MCP spec doesn't surface (timeout, abort, schema violation)
into one branch — most callers only care "did we get a value?" and the
nested discriminator is there when they don't.

## Wire shape

The harness publishes a request envelope on the bus:

| Field                    | Value                                                                             |
| ------------------------ | --------------------------------------------------------------------------------- |
| `name`                   | `session:channel:elicitation` (exported as `ELICITATION_CHANNEL_FQN`)             |
| `surface`                | `session`                                                                         |
| `phase`                  | `delta`                                                                           |
| `metadata.requestType`   | `"request"`                                                                       |
| `metadata.correlationId` | `req:<ULID>`                                                                      |
| `metadata.replyTo`       | The harness's inbox address (`elicitation:<scopeId>`)                             |
| `payload.message`        | Human-readable prompt                                                             |
| `payload.schema`         | **JSON Schema** (projected from the live `StandardSchemaV1` via `toJsonSchema()`) |
| `payload.hints?`         | Free-form UX hints — by convention `hints.kind` is the client-side router key     |
| `payload.metadata?`      | Domain metadata stamped onto the envelope                                         |

`payload.schema` is intentionally the wire JSON Schema, **not** the
live `StandardSchemaV1`. Functions are not serializable across
transports; subscribers never see the validator. The harness keeps the
live schema locally and re-validates accepted responses server-side
(sync OR async validators both supported).

Transports / devtools / MCP hosts subscribe to the channel, render the
prompt, and reply via `harness.respond({ correlationId, outcome,
value?, reason? })`.

## Snapshot-first: connect late, still see the pending ask (§6.1)

The channel is **snapshot-first** (the K8s watch-list model — the harness is a
`ChannelSnapshotProvider`). A subscriber that opens the channel _while a prompt
is already outstanding_ receives that ask in **frame one** — no more missing the
question just because you connected after it was asked.

```typescript
// Server: an ask goes out, no one is watching yet.
void session.elicitation.elicit({ message: "Deploy to prod?", schema });

// Client connects LATE — and still gets the pending ask in the opening frame:
const sub = client.transport.subscribe(
  { kind: "session", id: sessionId },
  { surface: "session", name: { exact: ELICITATION_CHANNEL_FQN } },
);
const { envelope } = (await sub[Symbol.asyncIterator]().next()).value;
// envelope.payload = { kind: "snapshot", requests: [{ correlationId, replyTo, payload }] }
for (const ask of envelope.payload.requests) render(ask); // the "Deploy to prod?" prompt
```

The opening frame is an `ElicitationSnapshotFrame`
(`{ kind: "snapshot", requests: [...] }`) whose entries mirror a live request
delta (`correlationId` / `replyTo` / wire `payload`) — a seeded subscriber ends
up in the same state as one that watched the ask go by live. It carries **no**
`metadata.requestType`, so a request-only fold skips it; live deltas follow on
the same stream.

## Command hooks — `elicit` is hookable (ADR 80 / 83)

The elicit round-trip routes through `BaseHarness.runOperation` (via the private
`elicitOp` wrapper), so it fires the ADR-83 interceptor seam — guards, `.use()`
middleware, and the derived **command lifecycle hooks** — plus the full phase
contract (`requested` → `before` → terminal). **ONE op models the WHOLE
round-trip:** the `before` face is the outbound request; the `after` face is
the resolved `ElicitationResult`.

| Verb     | CommandRegistry key  | Hooks                                                    |
| -------- | -------------------- | -------------------------------------------------------- |
| `elicit` | `elicitation:elicit` | `onBeforeElicitationElicit` / `onAfterElicitationElicit` |

```typescript
// Declarative (returns an Unsubscribe):
const off = harness.hook({
  onBeforeElicitationElicit: (request) => ({ ...request, message: reword(request.message) }),
  onAfterElicitationElicit: (result) => audit(result), // void observes; return to transform
});

// Per-verb imperative (typed Proxy):
harness.hooks.onBeforeElicitationElicit((request) => vetIfUnsafe(request));
```

- **`onBeforeElicitationElicit(request)`** fires **before the request envelope
  is published**. Return a reshaped request to **transform** the prompt (the
  reshaped request is what goes on the wire), `void` to **observe**, or `throw`
  to **veto** (the op aborts on the `E` channel — no request is published and
  `elicit()` rejects).
- **`onAfterElicitationElicit(result)`** fires **when the reply resolves
  locally** — after schema re-validation, on the single `ElicitationResult`
  discriminated union. Return a value to **transform** the terminal the caller
  sees, `void` to **observe**.

**Form + URL share ONE op.** They are two `mode`s of the same "ask the user"
verb (mirrors MCP's single `elicitation/create`), so `request.mode` on the
hook's input discriminates. There is no `onBeforeElicitationElicitUrl` — one
verb, one hook pair.

**`respond()` is NOT a separate op.** It is the reply **delivery** that unblocks
the awaiting op body — the "after" side of the round-trip — so it stays outside
the op surface. The after-hook, not a `respond` hook, is where you observe the
reply.

### Wire nuance — hookable server-side, effect crosses to the client

Unlike a purely in-process command, an elicit **inherently crosses to the
client**: the op body's inner `this.request(ELICITATION_CHANNEL, …)` publishes
the prompt on the bus and awaits the client's `respond()`. The **hooks run
server-side** around that crossing — `onBefore…` before the request envelope is
published, `onAfter…` after the reply resolves locally — so the op is fully
hookable even though its _effect_ is a wire round-trip.

The op itself is **not wire-addressable** (no `CommandDescriptor` is declared):
an elicit is _driven_ locally (by a tool handler, session code, or an inbound
`elicit-request` from another harness) and only its **payload** projects to the
client. A remote client can't invoke `elicitation:elicit` as a command — it
participates only as the far side of the round-trip via `respond()`.

## Form-mode schema flatness (#271) — utility for MCP wire callers

The MCP `elicitation/create` request schema is a restricted subset of
JSON Schema: clients render the request as a flat UI form and don't
support nested objects or free-form arrays. The 2025-11-25 GA + 2025-
06-18 draft specs both require `requestedSchema` to be a flat object
with primitive properties.

**This harness does not enforce the rule.** The harness is transport-
agnostic — bus subscribers may be MCP-server projections (constrained
to flat schemas), React UIs (which render anything), devtools, or
custom in-process clients. Enforcing MCP's UI limitation at the
substrate layer would push MCP's constraint onto every subscriber.

Instead, the package exports validation helpers for **code about to
put a schema on the MCP wire**:

```ts
import { assertFlatSchema, checkFlatSchema } from "@agentick/elicitation";
import { ElicitSchemaTooComplex } from "@agentick/spec";

// In a custom MCP-server projection / wire codec:
const wire = toJsonSchema(request.schema);
try {
  assertFlatSchema(wire); // throws ElicitSchemaTooComplex on violation
  await sdkServer.request({ method: "elicitation/create", params: { requestedSchema: wire } });
} catch (err) {
  if (err instanceof ElicitSchemaTooComplex) {
    // err.issues — human-readable violations
    // err.schema — the offending JSON Schema
  }
}

// Or non-throwing:
const issues = checkFlatSchema(wire);
if (issues.length > 0) {
  /* fall back to a flatter schema */
}
```

The framework's `buildMcpElicit` sugar (`text` / `confirm` / `select` /
`multiSelect` / `number` / `boolean` / `url` + try variants) uses TS-
level `FlatProperty` types and produces flat schemas by construction —
runtime validation is only needed by adopters writing custom MCP-server
projection code (alternative transports, hand-rolled
`elicitation/create` bridges).

**Allowed at the property level.** `string` / `number` / `integer` /
`boolean` primitives; single-select string enum (`type: "string"` +
`enum: [...]`); multi-select `array` whose items enumerate options
(`items.enum` or `items.anyOf` with `const` + `title`).

**Disallowed.** Nested `object` properties; free-form string arrays;
discriminated unions / intersections / property-level `anyOf` other
than the spec-defined labeled-enum form. The rule is binary in the
spec — there is no "shallow nesting OK" middle ground.

## Client — `@agentick/elicitation/client`

The far side of the `session:channel:elicitation` request channel + the
`session/respond_to_elicitation` reply command: the surface an app frontend
uses to render pending elicitations and answer them. Depends on
`@agentick/client-core` (the ADR 87 sub-handle registry) + spec types — NOT on
the elicitation harness runtime, so it stays out of a browser bundle. Mirrors
the tasks/knobs `/client` convention.

Importing this subpath contributes the elicitation surface to the client
`SessionHandle` (install-to-appear — the client twin of the server's
`bridges.elicitation`). It keeps client-core harness-agnostic (same
bundled-not-privileged law as tasks/knobs).

`session.elicitations` is a `ClientHandle`: `list()`/`get(id)`/`subscribe(cb)`
over the PENDING asks, `respond(id, body)` to answer. `list()` yields ITEM
HANDLES — each an ask's data PLUS its bound verbs `.accept`/`.decline`/`.cancel`.

**Connect late, see the ask — 5 lines.** `list()` is snapshot-first: a client
that connects mid-ask gets the outstanding prompt (friction #9), and the item's
verb round-trips exactly like a live one:

```ts
import "@agentick/elicitation/client"; // side-effect: types + registers the slot

const asks = client.session(id).elicitations;
asks.subscribe(() => {
  for (const e of asks.list()) showDialog(e); // ← includes the pending ask
});
// a dialog button:  await e.accept({ name: "Ada" });   // (or e.decline(reason) / e.cancel())
```

- **The contract.** `list(): readonly ClientElicitationHandle[]` /
  `get(correlationId): ClientElicitationHandle | undefined` (Enumerable —
  reflects PRE-connection pending state); `subscribe(cb: () => void)` fires on
  change, `cb` takes NO arguments; `respond(correlationId, body)` (Respondable —
  the by-id escape hatch for code not holding an item; rejects an unknown/
  already-answered id); `close()`. Answering — by item verb or by id — drops the
  ask from `list()`. Passes `runClientHandleConformance` (core + Enumerable +
  Respondable + the mid-ask listed-item round-trip).
- **No `AsyncIterable`** (client-handles §3 — observe unbounded, iterate
  bounded). The read surface is `list()` + `subscribe`, never `for await`.
- **`elicitationsHandle(client, sessionId, fromCursor?)`** is exported as the
  free factory the slot registers — call it directly for the headless case.

```ts
// reply directly by correlationId (the escape hatch — no item handle needed):
await client.session(id).elicitations.respond(correlationId, {
  outcome: "accepted",
  value: { name: "Ada" },
});
```

## API

### `ElicitationHarness` (class)

```ts
new ElicitationHarness(scopeId, journal, bus, inbox, { defaultTimeoutMs? })
```

Implements `ElicitationHarnessProtocol`. Extends
`BaseHarness<"elicitation">`. Also exposes `pendingCount()` as a
diagnostic on the concrete class (not on the protocol — clients must
not depend on it for control flow).

### `withElicitation()` — `SessionExtension` (no-op as of #159)

Drop into `createApp({ extensions: [...] })`. **Does nothing at
install time.** The AppHarness is the single construction site for
per-session `ElicitationHarness` instances (#159) — it constructs
the harness BEFORE session-extension installs run and exposes it on
`installer.elicitation`, `ctx.elicitation`, `bridges.elicitation`,
and `session.elicitation`. Constructing a second instance inside
this extension would collide on the inbox address
(`elicitation:${sessionId}:elicitation`) and fork the registry that
`bridges.*` vs `ctx.*` resolve to.

The factory survives as a documented symmetry slot with `withTasks()`
and as the future seam for per-session elicitation configuration
hooks. Today it accepts no options; tomorrow it may grow back
`onElicit`-style middleware once the AppHarness exposes a config seam.

Roadmap & known gaps:

- The pre-#159 `defaultTimeoutMs` option was removed — `withElicitation()`
  no longer constructs the harness, so it can't forward construction
  config. Reinstating per-app defaults requires a new seam on
  `createApp({ elicitation: { defaultTimeoutMs } })` and is tracked
  separately.

### `buildSessionElicit({ harness })`

Wraps an `ElicitationHarnessProtocol` in the `Elicit` sugar surface
(see ADR 43 §"Elicit sugar"). Used by `tool-executor-next` to build
`ctx.elicit` for in-process tool handlers and by `session-next` to
expose `session.elicit`. Each method routes through `harness.elicit`
with an inline Standard-Schema validator sized for the primitive
being asked.

### `runElicitationHarnessConformance(factory)`

Importable conformance suite (vitest). The factory returns a shell:

```ts
interface ElicitationConformanceShell {
  harness: ElicitationHarnessProtocol;
  nextCorrelationId(): Promise<string>; // tap the impl's outbound channel
  close(): Promise<void>; // idempotent
}
```

Drop into any package that ships an `ElicitationHarnessProtocol` impl
to verify all 13 invariants in one call.

### `ELICITATION_CHANNEL` / `ELICITATION_CHANNEL_FQN`

Channel-name constants exported from this package (NOT from spec — the
name is an implementation detail of where THIS harness publishes).
Subscribers import these directly.

## Protocol surface (`ElicitationHarnessProtocol`)

```ts
interface ElicitationHarnessProtocol {
  readonly id: string;
  readonly ready: Promise<void>;
  elicit<TSchema extends StandardSchemaV1>(
    request: ElicitationRequest<TSchema>,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ElicitationResult<InferOutput<TSchema>>>;
  respond(response: ElicitationResponse): Promise<void>;
  close(): Promise<void>;
}
```

**`respond()` is one code path.** The in-process convenience routes
through `inbox.send()` as a `request-response` envelope, so the same
`BaseHarness.dispatchMessage` auto-intercept handles in-process and
cross-process replies. First-write-wins on the correlation registry:
duplicate responses, stale responses after timeout, responses after
close — all silent no-ops.

**`close()` cancels pending elicitations.** Every in-flight `elicit()`
resolves to `{ outcome: "failed", failure.kind: "aborted",
failure.reason: "harness_closed" }`. Idempotent.

## The `Elicit` sugar surface (ADR 43)

`ElicitationHarnessProtocol.elicit(request)` is the **raw substrate**
— takes a structured request with a Standard-Schema validator,
returns an `ElicitationResult` discriminated union. Power-user-y;
correct for cluster-portable cross-transport routing.

For tool handlers and session-level code, the sugar wrapper is much
nicer. The **`Elicit` noun-aliased interface** lives in
`@agentick/spec/protocol/elicit-api.ts` and gives you typed
single-call methods:

```ts
import { buildSessionElicit } from "@agentick/elicitation";

const elicit = buildSessionElicit({ harness: someElicitationHarness });

const name = await elicit.text("Your name?", { default: "Ada" });
const role = await elicit.select("Role?", ["admin", "viewer"] as const);
const confirmed = await elicit.confirm("Proceed?");
const count = await elicit.number("How many?", { min: 1, max: 100, integer: true });
await elicit.url({ message: "Sign in to Google", url: oauthUrl });
```

Decline / cancel throw `ElicitationDeclined` / `ElicitationCancelled`
(both `AgentickError` subclasses under `ElicitError`). Use the `try*`
variants — `tryText`, `tryConfirm`, etc. — for non-throwing semantics
that return an `ElicitOutcome<T>` discriminated union.

**Cross-transport portability.** The same `Elicit` interface is
exposed in three places:

| Where                                         | How it's built                                                                | What it does underneath                              |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ctx.elicit` (in-process tool handler)        | `buildSessionElicit(harness)` in `tool-executor-next/harness.ts`              | calls `harness.elicit({mode, message, schema})`      |
| `ctx.elicit` (MCP-server tool handler)        | `buildMcpElicit({ sdkServer, clientCapabilities })` in `@agentick/mcp/server` | calls `sdkServer.request("elicitation/create", ...)` |
| `session.elicit` (session-level command code) | `buildSessionElicit(harness)` in `session-next/harness.ts`                    | identical to in-process tool-handler case            |

Tool handlers writing `await ctx.elicit?.text(...)` are wholly
portable across in-process and MCP-server transports. The same is
true for `session.elicit` vs. a tool handler's `ctx.elicit` — same
noun, same methods, same `ElicitationDeclined`/`Cancelled` exception
classes.

**Deferred-auth via `requireUrls`** — `ctx.elicit.requireUrls([...])`
throws `UrlElicitationRequired` (cross-transport class under
`ElicitError`). The MCP wire codec maps to the `-32042` JSON-RPC
error; in-process transports handle it however the host wants. Same
class, same usage, transport-aware serialization.

## Testing

`@agentick/elicitation/testing` ships two doubles:

- `fakeElicitation()` — real `ElicitationHarness` wired to in-memory
  substrate (`MemoryJournal + LocalEventBus + LocalInbox`). Default
  `harnessId` carries a ULID suffix to prevent address collisions
  across concurrent test instances.
- `stubElicitation({ result, onElicit, id })` — canned-answer double.
  Use when the SUT only interacts with the protocol surface and you
  want deterministic outcomes without a round-trip. The `elicit`
  method is properly generic — schema output flows to the result's
  `value` type.

```ts
import { fakeElicitation, stubElicitation } from "@agentick/elicitation/testing";
```

## Status

- ✅ Harness implementation, sync + async Standard-Schema validation
- ✅ Wire payload carries projected JSON Schema (no functions on the wire)
- ✅ `respond()` routes through inbox (one resolution path,
  in-process == cross-process)
- ✅ `close()` cancels pending; respond-after-close is no-op
- ✅ Module augmentation (`bridges.elicitation` — required slot)
- ✅ MCP-aligned protocol shape: `mode: "form" | "url"` discriminated
  union, three response actions (`accepted` / `declined` / `cancelled`)
  match MCP's `accept` / `decline` / `cancel` verbatim
- ✅ Tool-confirmation delegates to `ElicitationHarness` — the parallel
  `session:channel:tool_confirmation` channel is retired; tool
  confirmation publishes on `session:channel:elicitation` with
  `hints.kind: "tool_confirmation"`
- ✅ Conformance suite (13 tests) + harness-specific spec (7 tests)
  - `stubElicitation` spec (9 tests) — all green; tool-executor's
    confirmation flow (8 tests) covers the end-to-end integration
- ✅ URL-mode elicitation — `elicit({ mode: "url", url,
elicitationId, ... })`. `accepted` outcome signals user consent
  to open the URL (consent-only terminal); out-of-band completion
  arrives via a separate notification path (OAuth-via-elicit, #134b).
- ✅ MCP server-side mapping — `elicitation/create` (form + URL)
  routes via inbox from `McpClientHarness` to the session's
  `ElicitationHarness` (cluster-friendly seam — see `@agentick/mcp`).
- ⏳ MCP completion notifications (`notifications/elicitation/complete`)
  for async URL flows (#134b)
- ⏳ React surface — `useElicitation()` hook + reference
  `ElicitationPrompt` component

## Roadmap & known gaps

- **No server-side `cancel(correlationId)`.** Today only the caller's
  `AbortSignal` can cancel a specific in-flight elicit. `close()`
  cancels all. A targeted `cancel(correlationId, reason?)` belongs on
  the protocol for "client gave up but session is still alive"
  scenarios — pending.
- **No structured `reasonCode` field.** `reason?: string` is free-form;
  consumers needing programmatic branching on decline/cancel reasons
  rely on string matching today. A `reasonCode?: string` alongside the
  human-readable `reason` would let consumers code against MCP's
  documented codes — pending.
- **Cross-process elicitation untested.** The inbox routing path
  works (BaseHarness auto-routes), but explicit conformance for
  cluster-routed responses is pending alongside a cluster-substrate
  test impl.
- **`BaseHarness.request()` daemon-fiber leak on Promise abandonment.**
  Mitigated here by the 5-minute default timeout (registry entry
  always eventually evicts). The real fix is a `Scope`-aware
  `BaseHarness.request()` — a separate substrate-level task.

## Verified by

- `src/__tests__/conformance.spec.ts` — runs the full exported
  `runElicitationHarnessConformance` suite against this package's
  impl. Covers: accepted round-trip; async validator support;
  schema-violation failure; declined / cancelled pass-through;
  timeout; pre-aborted + mid-flight aborted signal; double-respond
  first-write-wins; stale-respond-after-terminal no-op;
  unknown-correlationId no-op; concurrent elicitations with
  out-of-order responses; `close()` cancels pending. (13 tests)
- `src/__tests__/harness.spec.ts` — impl-specific: wire envelope
  shape (channel name, metadata routing fields, payload structure,
  JSON Schema projection), `harness.id` matches scopeId, `ready`
  resolves before respond, close()-then-respond is no-op, respond()
  actually routes through inbox. (6 tests)
- `src/__tests__/stub-elicitation.spec.ts` — protocol shape, default
  declined result, custom canned result, failed result shape,
  `onElicit` spy hook fires with request + opts, respond + close
  no-ops. (9 tests)
- `src/__tests__/command-hooks.spec.ts` — `elicit` is hookable via
  `runOperation`: `deriveHookNames("elicitation:command:elicit")` ===
  `["onBeforeElicitationElicit", "onAfterElicitationElicit"]`; `onBefore`
  observes the outbound request; `onBefore` transforms the prompt (verified
  on the published wire envelope); `onAfter` transforms the terminal result;
  a `throw` in `onBefore` vetoes (no request published, `elicit()` rejects).
  (5 tests)
- `src/__tests__/pending-snapshot.spec.ts` — snapshot-first (§6.1): the harness
  is a `ChannelSnapshotProvider` for `elicitation`; a mid-ask
  `channelSnapshotPayload()` carries the pending ask mirroring the live delta
  (correlationId / replyTo / payload); multiple asks enumerate oldest-first; a
  resolved ask drops from the frame. (4 tests)

@see [`docs/proposals/v2/blueprint/26-harness-api-shape.md`](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
