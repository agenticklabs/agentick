# @agentick/elicitation-next

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
import { withElicitation, ELICITATION_CHANNEL_FQN } from "@agentick/elicitation-next";
import { jsonSchema } from "@agentick/spec-next";

const app = createApp(MyAgent, {
  extensions: [
    withElicitation({ defaultTimeoutMs: 60_000 }),
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
      case "timeout": cleanup(); break;
      case "aborted": abortPath(result.failure.reason); break;
      case "schema_violation": logSchemaIssues(result.failure.issues); break;
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

| Field                    | Value                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| `name`                   | `session:channel:elicitation` (exported as `ELICITATION_CHANNEL_FQN`)          |
| `surface`                | `session`                                                                      |
| `phase`                  | `delta`                                                                        |
| `metadata.requestType`   | `"request"`                                                                    |
| `metadata.correlationId` | `req:<ULID>`                                                                   |
| `metadata.replyTo`       | The harness's inbox address (`elicitation:<scopeId>`)                          |
| `payload.message`        | Human-readable prompt                                                          |
| `payload.schema`         | **JSON Schema** (projected from the live `StandardSchemaV1` via `toJsonSchema()`) |
| `payload.hints?`         | Free-form UX hints — by convention `hints.kind` is the client-side router key  |
| `payload.metadata?`      | Domain metadata stamped onto the envelope                                      |

`payload.schema` is intentionally the wire JSON Schema, **not** the
live `StandardSchemaV1`. Functions are not serializable across
transports; subscribers never see the validator. The harness keeps the
live schema locally and re-validates accepted responses server-side
(sync OR async validators both supported).

Transports / devtools / MCP hosts subscribe to the channel, render the
prompt, and reply via `harness.respond({ correlationId, outcome,
value?, reason? })`.

## API

### `ElicitationHarness` (class)

```ts
new ElicitationHarness(scopeId, journal, bus, inbox, { defaultTimeoutMs? })
```

Implements `ElicitationHarnessProtocol`. Extends
`BaseHarness<"elicitation">`. Also exposes `pendingCount()` as a
diagnostic on the concrete class (not on the protocol — clients must
not depend on it for control flow).

### `withElicitation(options?)` — `SessionExtension`

Drop into `createApp({ extensions: [...] })`. Constructs a per-session
harness wired to the session's substrate; registers as the
`elicitation` namespace; cleans up on session close. The `onClose`
handler is registered BEFORE the `ready` await so transient inbox
failures don't leak the harness.

Options:

- `defaultTimeoutMs` — wait bound applied when the caller omits
  `timeoutMs`. Default: 5 minutes.

### `runElicitationHarnessConformance(factory)`

Importable conformance suite (vitest). The factory returns a shell:

```ts
interface ElicitationConformanceShell {
  harness: ElicitationHarnessProtocol;
  nextCorrelationId(): Promise<string>;  // tap the impl's outbound channel
  close(): Promise<void>;                 // idempotent
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

## Testing

`@agentick/elicitation-next/testing` ships two doubles:

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
import { fakeElicitation, stubElicitation } from "@agentick/elicitation-next/testing";
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
  + `stubElicitation` spec (9 tests) — all green; tool-executor's
  confirmation flow (8 tests) covers the end-to-end integration
- ⏳ URL-mode elicitation — protocol shape staged; calling
  `elicit({ mode: "url", ... })` throws
  `UnsupportedElicitationModeError` until wired. URL mode lands
  alongside the MCP server-side mapping.
- ⏳ MCP server-side mapping (`elicitation/create` →
  `bridges.elicitation.elicit`); MCP completion notifications
  (`notifications/elicitation/complete`) for async URL flows
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

@see [`docs/proposals/v2/blueprint/26-harness-api-shape.md`](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
