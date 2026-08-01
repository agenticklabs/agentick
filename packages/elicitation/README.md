# @agentick/elicitation

**Ask the user a question, get a typed answer back.** One primitive backs every user-in-the-loop step in the framework — tool confirmation, MCP `elicitation/create`, an agent asking "which file did you mean?", an approval gate in your own code. One channel, one correlation engine, one set of timeout/abort semantics.

Two bets shape the design. First, **`elicit()` never throws**: user decision, transport failure, timeout, abort, and schema violation all land on a single discriminated union, so the caller writes one `switch` instead of a `try` plus a `switch`. Second, **the channel is snapshot-first**: a client that connects while a prompt is already outstanding receives that prompt in frame one, so "the user reloaded the page mid-question" isn't a lost question.

## Install

```bash
npm install @agentick/elicitation
```

Subpaths: `/client` (browser-side pending-ask handle), `/testing` (doubles + conformance suite).

## Quick start

A tool handler asks before it does something destructive:

```ts
import { rm } from "node:fs/promises";
import { createTool } from "@agentick/tool";
import { z } from "zod";

export const DeleteFile = createTool({
  name: "delete_file",
  description: "Delete a file from the workspace",
  inputSchema: z.object({ path: z.string() }),
  handler: async ({ path }, { ctx }) => {
    const approved = await ctx.elicit?.confirm(`Delete ${path}?`);
    if (!approved) return "The user declined — nothing was deleted.";
    await rm(path);
    return `Deleted ${path}.`;
  },
});
```

`ctx.elicit` is `undefined` when no elicit transport is mounted, so guard it. Everything else — publishing the prompt, correlating the reply, validating it, timing out — is handled.

> [!IMPORTANT]
> The same handler runs unchanged inside an MCP server. `ctx.elicit` is one interface with two implementations underneath: in-process it drives this package; in an MCP server it drives `elicitation/create` on the connected client. Write against the interface and the transport stops mattering.

## The sugar surface

`Elicit` is the typed one-call surface. Each method builds a flat schema, sends it, and unwraps the answer:

```ts
const branch = await elicit.text("Name the branch", { pattern: "^[a-z][a-z0-9-]*$" });
const target = await elicit.select("Deploy where?", ["staging", "prod"] as const);
const replicas = await elicit.number("How many replicas?", { min: 1, max: 10, integer: true });
const scopes = await elicit.multiSelect("Which scopes?", ["read", "write", "admin"] as const);
const proceed = await elicit.confirm("Proceed?");

await elicit.url({ message: "Sign in to GitHub", url: authorizeUrl });
```

`select` and `multiSelect` are `const`-generic, so `target` is `"staging" | "prod"` — not `string`.

Every option a method takes reaches the client as JSON Schema, so a UI can render the field rather than guess at it: `pattern` / `format` / `minLength` / `maxLength` on `text`, `minimum` / `maximum` and `type: "integer"` on `number`, `enum` on `select`, `minItems` / `maxItems` on `multiSelect`, and `default` throughout. `labels` becomes `enumNames`, positionally aligned with `enum` and falling back to the raw option for anything unlabelled. The schema describes the **value** being asked for (`{ type: "string", … }`), which is exactly what the client accepts with — `handle.accept(value)` takes the bare answer, and the same schema re-validates it server-side. The MCP projection wraps that identical property in the single-key flat object its wire demands; the shape vocabulary (`textProp`, `enumProp`, …) is shared between them.

These throw `ElicitationDeclined` / `ElicitationCancelled` when the user says no. When "no" is an ordinary outcome rather than an exception, use the `try*` twin and branch on the status:

```ts
const outcome = await elicit.tryConfirm("Run the migration now?");
switch (outcome.status) {
  case "accept":
    if (outcome.value) await runMigration();
    break;
  case "decline":
  case "cancel":
    log(`skipped: ${outcome.reason ?? "no reason given"}`);
    break;
}
```

Every throwing form-mode method has one: `tryText`, `trySelect`, `tryMultiSelect`, `tryConfirm`, `tryNumber`, `tryBoolean`, `tryUrl`. `canDoForm()` / `canDoUrl()` probe what the current transport supports.

**Deferred auth.** `requireUrls([...])` throws `UrlElicitationRequired` carrying the URLs a caller must walk before retrying. It is the OAuth pattern as a single statement: the handler detects "I need consent first", packages the URLs, and never returns.

```ts
if (!(await hasToken())) {
  elicit.requireUrls([{ message: "Connect your Google account", url: consentUrl }]);
}
```

`buildSessionElicit` is the factory behind `ctx.elicit` and `session.elicit`. Build your own over a harness instance:

```ts
import { buildSessionElicit } from "@agentick/elicitation";

const elicit = buildSessionElicit({ harness }); // harness: ElicitationHarnessProtocol
```

## The raw call — arbitrary schemas, one union

Under the sugar is `elicit(request, opts)`: any Standard Schema, any hints, and a result union with no exceptions in it.

```ts
import { z } from "zod";

const result = await harness.elicit(
  {
    message: "Approve calling `delete_file` on /tmp/draft.txt?",
    schema: z.object({ approved: z.boolean(), note: z.string().optional() }),
    hints: { kind: "tool_confirmation", acceptLabel: "Approve", destructive: true },
    metadata: { toolName: "delete_file", input: { path: "/tmp/draft.txt" } },
  },
  { timeoutMs: 30_000, signal },
);

switch (result.outcome) {
  case "accepted":
    if (result.value.approved) await runTool(result.value.note);
    break;
  case "declined":
  case "cancelled":
    explain(result.reason);
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
        report(result.failure.issues);
        break;
    }
}
```

`accepted` / `declined` / `cancelled` mirror MCP's three elicitation actions verbatim, and pass through with their `reason` intact. `failed` collapses the three system-driven terminals MCP has no vocabulary for — timeout, abort, schema violation — into one branch, with a nested discriminator for callers who care which.

Validation happens **server-side, against the live schema**, after the reply comes back. Async validators (a Zod `refine`, a Valibot `pipeAsync`) are awaited; a violation resolves to `failed`, never throws.

`url` mode is the same call with a different shape: `{ mode: "url", message, url, elicitationId }`. Its `accepted` terminal carries `value: undefined` and means **the user consented to open the URL** — not that the out-of-band flow finished. Completion is a separate signal you layer on top of the consent.

## Wire shape

The request goes out as one envelope on one channel:

| Field                            | Value                                                                 |
| -------------------------------- | --------------------------------------------------------------------- |
| `name`                           | `session:channel:elicitation` (exported as `ELICITATION_CHANNEL_FQN`) |
| `surface` / `phase`              | `session` / `delta`                                                   |
| `metadata.requestType`           | `"request"`                                                           |
| `metadata.correlationId`         | `req:<ULID>`                                                          |
| `metadata.replyTo`               | The inbox address to answer on                                        |
| `payload.mode`                   | `"form"` \| `"url"`                                                   |
| `payload.message`                | The human-readable prompt                                             |
| `payload.schema`                 | **JSON Schema** — projected from the live Standard Schema (form mode) |
| `payload.url` / `.elicitationId` | URL mode only                                                         |
| `payload.hints?`                 | UX hints; `hints.kind` is the conventional client-side renderer key   |
| `payload.metadata?`              | Domain metadata, stamped through untouched                            |

> [!IMPORTANT]
> `payload.schema` is the wire JSON Schema, never the live validator. Functions don't serialize, and a subscriber that could see the validator would be tempted to trust client-side validation. The live schema stays server-side and re-validates every accepted reply.

## Connect late, still see the ask

The channel's opening frame is a snapshot of every outstanding prompt — the watch-list model. A subscriber that opens the channel mid-ask is put in the same state as one that watched the ask go by live.

```ts
import "@agentick/elicitation/client"; // side effect: types + registers the slot

const asks = client.session(sessionId).elicitations;

asks.subscribe(() => {
  for (const ask of asks.list()) showDialog(ask); // includes asks raised before we connected
});
```

That is the whole loop. `list()` returns **item handles** — each is the ask's data (`correlationId`, `message`, `schema`, `hints`, `mode`, …) plus its bound verbs, so a dialog button is one call:

```ts
await ask.accept({ approved: true });
await ask.decline("not right now");
await ask.cancel();
```

Answering — by verb or by id — drops the ask from `list()` and fires subscribers. The by-id escape hatch is there for code that isn't holding an item:

```ts
await asks.respond(correlationId, { outcome: "accepted", value: { approved: true } });
```

An unknown or already-answered id rejects rather than silently no-oping. `elicitationsHandle(client, sessionId, fromCursor?)` is the free factory the slot registers — call it directly for the headless case.

> [!NOTE]
> The handle is not `AsyncIterable` by design: `list()` plus `subscribe()` observes an unbounded stream; `for await` is for bounded ones. The snapshot frame is also authoritative on arrival — it clears and reseeds the pending set, so asks answered while a client was away don't linger.

## Hooks — the whole round-trip is one operation

`elicit` runs as an operation, which means the standard interceptor seam applies: guards, `.use()` middleware, and a derived hook pair. **One operation models the whole round-trip** — the before face is the outbound request, the after face is the resolved result.

| Verb     | Hooks                                                    |
| -------- | -------------------------------------------------------- |
| `elicit` | `onBeforeElicitationElicit` / `onAfterElicitationElicit` |

```ts
const off = harness.hook({
  // Return a reshaped request to transform the prompt; the reshaped
  // request is what actually goes on the wire.
  onBeforeElicitationElicit: (request) => ({ ...request, message: redact(request.message) }),
  // Return a value to transform the terminal the caller sees; void observes.
  onAfterElicitationElicit: (result) => void audit(result),
});

// Per-verb imperative form:
harness.hooks.onBeforeElicitationElicit((request) => {
  if (looksLikeExfiltration(request)) throw new Error("blocked");
});
```

Throwing in the before hook **vetoes**: no request is published and the call rejects.

Form and URL are two modes of one verb — mirroring MCP's single `elicitation/create` — so there is no separate URL hook; discriminate on `request.mode`. `respond()` is deliberately _not_ an operation: it is reply delivery, the mechanism that unblocks the awaiting body. Observe replies in the after hook.

The hooks run server-side even though the effect crosses the wire: `onBefore` fires before the envelope is published, `onAfter` after the reply resolves locally. The operation itself is not wire-addressable — a remote client can't invoke it, it participates only as the far side of the round-trip.

## Lifecycle guarantees

**`respond()` is one code path.** The in-process convenience routes through the inbox as a `request-response` envelope, so in-process and cross-process replies resolve identically. First write wins: duplicate replies, replies after a timeout, replies to an unknown correlation id, and replies after close are all silent no-ops.

**`close()` cancels everything pending.** Each in-flight call resolves to `{ outcome: "failed", failure: { kind: "aborted", reason: "harness_closed" } }`. Idempotent.

**Timeouts always fire.** Without an explicit `timeoutMs` the default is five minutes — long enough for a human, short enough that a forgotten prompt eventually frees the fiber.

## Driving an elicit from another component

Any component holding an address can drive an ask without an object reference, which is what makes the path cluster-portable. Send an `elicit-request` to the elicitation inbox address with your own `replyTo` and `correlationId`; the result routes back as a `request-response` envelope your own request registry resolves.

```ts
import { ELICIT_REQUEST_MESSAGE_TYPE, type ElicitRequestInboxPayload } from "@agentick/elicitation";

const payload: ElicitRequestInboxPayload = { request, replyTo: myAddress, correlationId };
await Effect.runPromise(
  inbox.send(elicitationAddress, {
    type: ELICIT_REQUEST_MESSAGE_TYPE,
    correlationId,
    payload,
  }),
);
```

This is how [@agentick/mcp](../mcp) routes an inbound `elicitation/create` to the owning session. A schema sent this way must be a `jsonSchema(...)`-wrapped Standard Schema — functions don't cross the inbox either.

## Patterns

**Tool confirmation.** A declaration marked `requiresConfirmation` runs through this exact channel with `hints.kind: "tool_confirmation"`. There is no parallel confirmation channel. See [@agentick/tool-executor](../tool-executor).

**MCP.** [@agentick/mcp](../mcp) bridges both directions: a server-side `ctx.elicit` built on `elicitation/create`, and an inbound `elicitation/create` routed to the session over the inbox protocol above.

**Tasks.** [@agentick/tasks](../tasks) reuses the same sugar surface over an escalation-backed transport, so a detached worker's question walks up the ownership chain to whoever can answer it — and no dependency on this package is needed to do it, because `buildElicitSugar` takes a bare function.

**Shapes.** [@agentick/spec](../spec) owns `ElicitationRequest`, `ElicitationResult`, `ElicitationHarnessProtocol`, the `Elicit` interface, `ClientElicitationHandle`, and the `ElicitationDeclined` / `ElicitationCancelled` / `UrlElicitationRequired` / `ElicitSchemaTooComplex` error classes.

### MCP form-schema flatness — an opt-in validator, not a policy

MCP's `elicitation/create` accepts only a restricted schema subset: a flat object of primitive properties, plus enum-shaped single- and multi-select. That is a **constraint of the MCP wire**, not of asking a user something. Subscribers here include React UIs that render anything, devtools, and custom in-process clients, so the rule is not enforced on the way out — pushing MCP's UI limitation onto every subscriber would be the wrong trade.

Instead the rule ships as a function, for code about to put a schema on the MCP wire:

```ts
import { assertFlatSchema, checkFlatSchema } from "@agentick/elicitation";
import { ElicitSchemaTooComplex, toJsonSchema } from "@agentick/spec";

const wire = toJsonSchema(request.schema);

const issues = checkFlatSchema(wire); // non-throwing: [] means wire-compatible
if (issues.length > 0) fallBackToSomethingFlatter(issues);

try {
  assertFlatSchema(wire); // throwing twin
  await sdkServer.request({ method: "elicitation/create", params: { requestedSchema: wire } });
} catch (cause) {
  if (cause instanceof ElicitSchemaTooComplex) report(cause.issues, cause.schema);
}
```

Allowed at the property level: `string` / `number` / `integer` / `boolean`; a single-select string enum; an `array` whose items enumerate options (`items.enum`, or `items.anyOf` of `const` + `title`). Disallowed: nested objects, free-form string arrays, and property-level unions outside the labeled-enum form. The rule is binary — there is no shallow-nesting middle ground.

The framework's own MCP sugar produces flat schemas by construction through its `FlatProperty` types, so this validator is for adopters writing custom projection code: alternative transports, hand-rolled `elicitation/create` bridges.

## API

### `@agentick/elicitation`

| Export                                                                   | Purpose                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `ElicitationHarness`                                                     | The implementation, for direct construction                  |
| `withElicitation()`                                                      | Session extension — a documented symmetry slot (see below)   |
| `buildSessionElicit({ harness })`                                        | The `Elicit` sugar over a live instance                      |
| `buildElicitSugar(elicitFn)`                                             | The transport-agnostic sugar core over a bare `ElicitFn`     |
| `assertFlatSchema` / `checkFlatSchema`                                   | MCP wire-schema validators (opt-in)                          |
| `textProp` / `numberProp` / `booleanProp` / `enumProp` / `multiEnumProp` | Flat JSON Schema builders for one form field                 |
| `flatObjectSchema(properties)`                                           | Wrap fields in the flat object MCP's `requestedSchema` needs |
| `ELICITATION_CHANNEL` / `ELICITATION_CHANNEL_FQN`                        | Channel-name constants for subscribers                       |
| `ELICIT_REQUEST_MESSAGE_TYPE`                                            | Inbox message type for cross-component asks                  |
| `PendingElicitation` / `ElicitationSnapshotFrame` (types)                | The opening-frame shapes                                     |
| `ElicitRequestInboxPayload` (type)                                       | The inbox payload shape                                      |

> [!NOTE]
> `withElicitation()` does nothing at install time and takes no options. The app is the single construction site for per-session instances — it builds one before session extensions install and exposes it on `ctx.elicitation`, `bridges.elicitation`, and `session.elicitation`. A second instance would collide on the inbox address and fork which registry `bridges.*` and `ctx.*` resolve to. The factory survives for symmetry with the other `withX()` extensions and as the seam for future per-session configuration.

### The protocol

```ts
interface ElicitationHarnessProtocol {
  readonly id: string;
  readonly ready: Promise<void>;
  elicit(request, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ElicitationResult>;
  respond(response: ElicitationResponse): Promise<void>;
  close(): Promise<void>;
}
```

`ElicitationHarness` also carries `pendingCount()` as a diagnostic on the concrete class — deliberately off the protocol, so nothing can build control flow on it — plus `snapshotChannel` and `channelSnapshotPayload()` from the channel-snapshot contract.

Construction: `new ElicitationHarness(scopeId, journal, bus, inbox, options)`, where options are `defaultTimeoutMs`, `parentScope` (session-scoped subscriptions filter on its `sessionId` — omit it and the gateway drops the envelope), `inheritedInterceptors`, and `interceptorParent`.

### `@agentick/elicitation/client`

| Export                                     | Purpose                                      |
| ------------------------------------------ | -------------------------------------------- |
| `session.elicitations`                     | Registered on import: the pending-ask handle |
| `elicitationsHandle(client, sessionId, ?)` | The free factory the slot registers          |
| `respondToElicitation(client, id, input)`  | Reply by `correlationId` without a handle    |

The handle: `list()` / `get(correlationId)` (Enumerable), `subscribe(cb)` with a zero-argument callback (the store contract), `respond(correlationId, body)` (Respondable), and `close()`.

`ELICITATION_CHANNEL` / `ELICITATION_CHANNEL_FQN` and the frame types (`ElicitationChannelName`, `ElicitationSnapshotFrame`, `PendingElicitation`) are re-exported here too, so a browser bundle that subscribes itself never has to reach for the root barrel — which would drag the server harness in with them.

### `@agentick/elicitation/testing`

| Export                                  | Purpose                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `fakeElicitation(options?)`             | A real instance on an in-memory substrate — the default choice |
| `stubElicitation(options?)`             | Canned-answer double, no round-trip                            |
| `runElicitationHarnessConformance(...)` | Certify an alternate implementation                            |

```ts
import { fakeElicitation, stubElicitation } from "@agentick/elicitation/testing";

// Working substrate — same code path production hits.
const { harness, bus, close } = await fakeElicitation({ defaultTimeoutMs: 1_000 });

// Canned answers — when the round-trip isn't what's under test.
const stub = stubElicitation({
  result: { outcome: "accepted", value: { approved: true } },
  onElicit: (request) => recorded.push(request),
});
```

`fakeElicitation` gives each instance a ULID-suffixed id so concurrent tests don't collide on inbox addresses. Its default result is `declined`, which forces a test to opt into the outcome it actually means.

The conformance suite takes a factory returning `{ harness, nextCorrelationId(), close() }` — `nextCorrelationId()` is how the suite pairs a call with its reply without the protocol exposing the correlation engine. An in-process implementation subscribes to its own bus; a remote one taps its outbound transport.

## Roadmap & known gaps

- **No targeted `cancel(correlationId)`.** Only the caller's `AbortSignal` cancels one in-flight ask; `close()` cancels all. "The client gave up but the session is alive" has no first-class verb.
- **`reason` is free-form.** There is no structured `reasonCode`, so code branching on _why_ a user declined is matching strings today.
- **Cross-process replies are untested.** The inbox routing works and is the same code path, but there is no conformance run against a cluster substrate.
- **Abandoned promises rely on the timeout.** A caller that abandons an `elicit()` promise leaves a registry entry until the timeout evicts it. The five-minute default bounds it; a scope-aware request primitive is the real fix.
- **No React surface.** There is no `useElicitation()` hook or reference prompt component; the client handle is the current binding point.
- **URL-mode completion.** Consent is modeled; out-of-band completion notifications for OAuth-style flows are not.
- **The sugar's schemas are hand-built.** The per-method validators and their JSON Schema shapes are written by hand rather than derived from one source, so a new constraint has to be added in both places (`elicit-sugar.ts` and `flat-props.ts`) to be both enforced and visible.

## Verified by

- `src/__tests__/conformance.spec.ts` — the full exported suite against this implementation: accepted round-trip, async validators, schema-violation failure, declined and cancelled pass-through with `reason`, timeout, pre-aborted and mid-flight aborted signals, double-respond first-write-wins, stale respond after a terminal, unknown correlation id, concurrent asks answered out of order, and `close()` cancelling pending.
- `src/__tests__/harness.spec.ts` — the wire envelope: channel name, `correlationId` / `replyTo` metadata, payload fields, the JSON Schema projection; `id` matching the scope id; `ready` resolving before a reply can land; close-then-respond as a no-op; `respond()` actually routing through the inbox; and URL mode's payload plus its accepted / declined / cancelled terminals.
- `src/__tests__/pending-snapshot.spec.ts` — the channel-snapshot contract, a mid-ask snapshot mirroring the live delta, multiple concurrent asks enumerated oldest-first, and a resolved ask dropping out of the frame.
- `src/__tests__/command-hooks.spec.ts` — hook-name derivation, the before hook observing and transforming the outbound request (asserted on the published envelope), the after hook transforming the terminal, and a throw in the before hook vetoing with no request published.
- `src/__tests__/elicit-sugar-schema.spec.ts` — the client-facing schema every sugar method publishes: `text`'s format / pattern / length bounds, `number`'s bounds and the integer-vs-number type, `confirm` / `boolean` defaults, `select`'s `enum` plus `labels` → positional `enumNames` (and no `enumNames` key without labels), `multiSelect`'s item schema with `minItems` / `maxItems` / `default`, a `try*` twin sending the same schema — each with its accept round-trip, plus violating replies still failing as `schema_violation`.
- `src/__tests__/flatness.spec.ts` — every accepted shape (primitives, single-select enum, enum and titled-`anyOf` multi-select) and every rejected one (non-object root, nested object, free-form array, missing items, unsupported type, array of objects), plus `assertFlatSchema` carrying issues and schema on the thrown error.
- `src/__tests__/stub-elicitation.spec.ts` — protocol shape, default declined result, custom and failed canned results, the `onElicit` spy, and respond/close as no-ops.
- `src/client/__tests__/elicitations-handle.spec.ts` + `elicitations-handle.conformance.spec.ts` — the snapshot frame seeding `list()` with item handles, an item's `accept()` reaching the wire and removing the ask, a live delta adding through the same constructor, `respond(id)` rejecting an unknown id, the zero-argument `subscribe` contract, and the shared client-handle conformance suite.
- End-to-end wire behavior is covered in [@agentick/transport-in-process](../transport-in-process); tool confirmation over this channel in [@agentick/tool-executor](../tool-executor); the MCP bridge in both directions in [@agentick/mcp](../mcp).
