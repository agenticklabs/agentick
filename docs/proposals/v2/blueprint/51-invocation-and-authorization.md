# ADR 51 — The harness invocation model + authorization architecture

**Status:** Draft · 2026-07-02
**Builds on:** ADR 26 (Harness API shape), ADR 27 (+ 2026-07-01 amendment:
harnesses are the behavior / verbs-not-configuration), ADR 29 (bus cursor
log), ADR 42 (slot dichotomy), ADR 45 (runtime context), ADR 46 (wire
extensions), ADR 47 (signals ride the bus), ADR 48 (layered isolation /
principal), ADR 49 (stores, not snapshots), ADR 50 (gateway extensions)
**Feeds:** ADR 34/#302 (auth: ingress authn + grant derivation), the
verb-coverage matrix, CUT-PLAN §B2/§C1
**Touches:** `@agentick/spec-next` (CommandDescriptor, `origin`,
`WireMethods` seam usage, AuthError family), `@agentick/runtime-next`
(`BaseHarness.command()`, dispatch-chain step), `@agentick/gateway-next`
(dynamic wire resolver, Authorizer gate), `@agentick/tool-executor-next`
(DispatchPolicy port), every harness package (verb declarations —
net-negative LOC migration)

## TL;DR

**Every harness is a network-addressable actor. Any operation is
invocable by a command message — a verb + serializable data, addressed
to a target — from any origin: host code, the rendered tree, another
process or cluster node, or a wire client. The target resolves the
command against its construction-bound configuration. Executable
configuration never travels; only verbs and data do.** The uniform
shape is **"do X now in/to/with Y."**

The complete surface of every harness is three projections of one
protocol:

- **Commands** — verb + serializable payload; request-response via the
  existing `request`/ask correlation, fire-and-forget via inbox `send`.
- **Queries** — bridge reads + `enumerate` (the
  enumeration-is-foundational rule).
- **Reactive status** — bus notifications (ADR 47).

None of the three carries executable configuration or credentials
across a boundary.

Authorization has **two subjects, two gates, one vocabulary**:

- **Identity authz** — *may this principal invoke this verb on this
  target?* Enforced ONCE, at the wire projection boundary, via an
  `Authorizer` port. Harnesses are authz-unaware, permanently.
- **Capability policy** — *may the agent (the model) perform this
  action?* Enforced ONCE, at tool dispatch, via a `DispatchPolicy`
  port (`allow | deny | ask`), generalizing the existing confirmation
  gate. The claude.json-style allow/deny/ask config is this gate's
  policy source.

`Operation` carries the **facts** (subject, verb, target, causal chain,
and a new `origin` provenance field) and never the **decisions**. The
journal — already the observability ledger (ADR 49) — becomes the
authorization audit log for free.

Nearly all of this is naming what the substrate already does. The net
new machinery is ~320 LOC across four packages, partially offset by
deleted `handleMessage` switches and hand-built Operation literals in
every migrated harness.

## 1. The invocation model

### 1.1 It's the actor model, already built

`scopeId` is the address, the inbox is the mailbox, `handleMessage` is
receive, the Operation envelope is the command protocol. The harness is
**origin-indifferent**: a command from host code, tree logic, another
node, or a wire client is the same envelope into the same mailbox with
the same phase contract, journaling, and idempotency. Timeline already
routes `timeline:append` / `timeline:queue` / `timeline:drain` this way;
the design below removes the hand-written switches, not the mechanism.

### 1.2 The data-vs-executable boundary (load-bearing invariant)

**Verbs and serializable data cross any boundary; executable
configuration never does.** Strategies, predicates, and validators are
construction-bound and server-resident (ADR 27 amendment). A remote
command *triggers* the target's configured behavior and may carry
**advisory data** (e.g. compaction `instructions` — the resident
strategy is authoritative to honor or ignore); it never supplies the
function. Same boundary as credentials-never-cross-wire; RCE-safe by
construction.

**Corollary — the signal-form rule:** an operation with a *required
function parameter* is unaddressable. Give it a construction-bound
default (`withTimeline({ compact: rollingSummary({...}) })`) and a
no-arg/data-only signal form, and it joins the addressable set. The
function-arg call form remains an in-process-only override
(inner-scope-wins at the call site).

**Footnote (wave-ratified, 2026-07-03) — optional function fields do
NOT trigger the exclusion.** The rule is about *required* function
parameters. A declaration whose input carries an *optional* function
field (knobs' `validate`, prompts' `render`) is declarable: the field
rides in-process invocations and degrades to absent over the
inbox/wire — the addressable form simply carries the data subset
(prompts' `template`). Precedent: `knobs:register`, `prompts:register`.

**Footnote (wave-ratified, 2026-07-03) — opIds canonicalize.** The
registry manufactures `${verb}:${ulid()}` opIds. Pre-registry literals
that embedded discriminators in the opId (mcp's
`mcp:${serverId}:call-tool:*`) canonicalize on migration: the
discriminator's provenance moves to the scope (where it belonged), the
op *name* keeps its exact identity (the journal/bus-queryable string),
and the opId remains what it always was — a per-call uniqueness token
nobody may parse. Verified zero opId-prefix consumers before ratifying.

### 1.3 Addressing — flat, location-transparent

`address = surface:scopeId` (e.g. `timeline:<sessionId>`). **The
address names identity, not topology.** `sessionId` is globally unique
and durable; gateway/app ids are deployment topology and would break on
failover/rehydration (ADR 49) if baked into addresses. Hierarchy lives
where it belongs: on `EventScope` (observability, isolation) and in
`ClusterPartitioning.keyFor(address)` (routing).

Origins name the target differently but converge on the same send:

- Wire clients name the **resource** via params
  (`{ method: "timeline/compact", params: { sessionId } }`); the
  resolver computes the mailbox. Clients never construct raw addresses.
- Server code holds the reference (`session.timeline.compact()`) or
  sends to the mailbox directly when it doesn't.
- Cluster routes the address to the owning node; nothing changes.

Gateway and app are themselves harnesses with mailboxes; their verbs
are addressable by the identical mechanism. One rule, zero special
cases.

## 2. The command registry

### 2.1 Declaration — single source of truth, built dynamically

```ts
// in the harness constructor — the ONLY place a verb is declared:
this.append  = this.command({
  name: TIMELINE_APPEND,            // "timeline:append"
  input: timelineAppendSchema,      // Standard Schema
  exposure: "addressable",          // default; see §2.3
  handler: (i) => this.appendEffect(i),
});
```

`command()` registers the descriptor into the per-instance registry and
returns the public method: it manufactures the exact Operation
harnesses hand-write today (`opId: \`${verb}:${ulid()}\``,
`name: \`${surface}:command:${rest}\``) and runs it through
`runOperation` unchanged. **One canonical verb string is
simultaneously:** the inbox message type, the op-name root, the authz
scope label, the capability-policy rule target, and (via `:`→`/`) the
wire method name. Packages export verb constants
(`TIMELINE_COMPACT = "timeline:compact"`) — house precedent, not a
mapping.

### 2.2 Dispatch — one step in the existing precedence chain

`BaseHarness.dispatchMessage` order becomes: request-response
interception → `customMessageHandlers` (`onMessage`) → **command
registry** (validate payload against the declared schema; stamp
`origin` from the envelope; invoke through the same public path; reply
via existing correlation) → `handleMessage` fallthrough. Existing
switches keep working and migrate opportunistically at negative LOC;
timeline is the migration proof (its switch and Operation literals are
deleted; `compact` finally joins the addressable set via its signal
form).

Validation happens **once, here** — at the verb, where the schema
lives. The wire does not duplicate it; a malformed payload travels one
in-process inbox hop and returns a typed validation error through the
correlation.

### 2.3 Exposure — curation lives on the declaration

`exposure: "internal" | "addressable" | "wire"` (widening levels;
default `"addressable"`, wire is opt-in per verb). The **harness
author** decides exposability — that's where the knowledge lives.
Which *principal* may invoke an exposed verb is a separate policy act
(§4). "Expose" and "grant" are different decisions on purpose.

### 2.4 Enumeration — declare-and-discover, not push

`commands()` enumerates the registry; each harness auto-registers one
meta-verb (`<surface>:commands`) so discovery composes with zero code
in harness packages. The wire's `commands/list` (§3) and the
verb-coverage matrix read this. The push flavor already exists:
ADR 47's `capabilities/changed` control-plane event.

## 3. Wire projection — named, typed, one generic implementation

### 3.1 No catch-all method; a dynamic resolver instead

The `WireExtensionRegistry` gains a **dynamic namespace resolver**,
registered once by the framework at construction, before seal.
Resolution order:

1. **Exact match** — hand-written wire extensions (porcelain). Always
   wins. `session/send`, `sub/subscribe`, `mcpClients/*`,
   `credentials/*` are untouched by this ADR.
2. **Dynamic resolver** — `timeline/compact` → verb `timeline:compact`
   → authorize (§4) → `inbox.ask(address, { type: verb, payload,
   origin: "wire" })`.

Explicit-beats-dynamic gives the porcelain/plumbing doctrine
mechanically: an *earned* named method (streaming semantics, bespoke
params, SDK ergonomics) shadows the auto-route by construction. New
capabilities default to the plumbing lane; **new capability requires
new declarations, never new plumbing.** `sub/*` can never be commands
(streams, cursor resume) and stays porcelain permanently.

### 3.2 Typed RPC — the augmentation seam, types derived from schemas

```ts
// timeline/src/augment.ts — same file that augments HookBridges:
declare module "@agentick/spec-next" {
  interface WireMethods {
    "timeline/compact": {
      params: InferInput<typeof compactSignalSchema> & { sessionId: string };
      result: CompactResult;
    };
  }
}
```

Compile-time types are **derived from the same Standard Schema** the
declaration carries — no drift between the claim and the runtime check.
The client is typed through the shared declaration (`client.call(
"timeline/compact", …)` fully inferred; proxy sugar later);
`commands/list` remains the runtime discovery surface for dynamic and
non-TS clients. No codegen, no IDL — this is `HookBridges` for the
wire, which ADR 46 already established.

### 3.3 Two lanes, one scope space (anti-bypass rule)

A named porcelain method's authz scope label **defaults to the
underlying verb's name** (`session/send` checks `session:send`). Grants
are written once and cover both lanes; a verb denied via the plumbing
lane cannot be reached via a porcelain wrapper under a different label.

## 4. Identity authorization

### 4.1 Two edges, each once

- **Authentication = ingress.** Transport token → `principal` +
  `RuntimeContextUser` (ADR 34/#302, the deferred ADR 50
  `interceptIngress`). Once per connection/request; stamped
  structurally from there (ADR 45/48).
- **Authorization = wire dispatch.** Before a wire command becomes an
  inbox message: `authorizer.authorize({ principal, scope, target })`.
  After that, it's inside. **Harnesses are authz-unaware, permanently**
  — in-harness checks are the runtime-filter anti-pattern ADR 47/48
  killed. The middleware chain remains a documented adopter escape
  hatch, never doctrine.

### 4.2 The Authorizer port

Promise-shaped, conformance-suited (triad: enforcement point = opinion;
port = protocol; policy = adopter's):

```ts
interface Authorizer {
  authorize(input: {
    principal?: string;
    scope: string;              // = the verb, by default
    target?: EventScope;        // target rule input
  }): Promise<{ allowed: boolean }>;
  readonly backend: string;
}
```

Bundled: `staticAuthorizer({ grants })` (principal → scope-pattern
list; covers the local pole and most cloud deployments) and
`permissiveAuthorizer()` (explicit opt-in for no-auth local
deployments; also the behavior when `principal` is undefined and auth
is unconfigured — graceful two-pole degradation). **Default target
rule: same-principal** (ADR 48 fusion rule — the target session's
`scope.principal` must equal the caller's), elevation via scopes;
most deployments never write a target rule.

Grant *derivation* — OAuth-style tokens carrying scope claims, or
client-declared scopes verified at ingress — is ADR 34's `AuthSource`
concern. The Authorizer consumes grants regardless of issuance; the
questions stay decoupled.

### 4.3 Posture + the hard sequencing constraint

Deny-by-default: unexposed verbs are unreachable; exposed verbs require
grants. **The dynamic resolver ships in the same change as the
Authorizer gate — never before.** The generic lane makes every
`exposure: "wire"` verb reachable; shipping it ungated is the
admin-verb-to-unprivileged-client bug at framework scale.

## 5. Trust domains + the fourth subject

| Origin | Trust | Gate |
| --- | --- | --- |
| Wire client | Untrusted | authn at ingress, authz at dispatch |
| Host code / tree / spawns | Trusted by construction | none — the app *is* the code |
| Cluster transport | Trusted channel between framework nodes | authorized once at its wire ingress; stamped `principal` travels in scope |
| **The model** | **Inside the process, intentionally untrusted** | **capability policy at tool dispatch (§6)** |

The model is the subject the identity-authz design cannot see:
model-originated actions are physically inside the trust boundary while
being the reason confirmation gates exist. Naming it is what separates
the two authorization subjects cleanly.

## 6. Capability policy (the claude.json seam)

### 6.1 One choke point, one port

Every model action flows through `ToolExecutor.dispatch`. The existing
hardcoded gate (`requiresConfirmation` + `alwaysAllowed` + elicitation
confirmation) generalizes in place into the `DispatchPolicy` port:

```ts
interface DispatchPolicy {
  evaluate(input: { tool: string; input: unknown; ctx: ... }):
    Promise<"allow" | "deny" | "ask">;
  learn?(rule: PolicyRule): Promise<void>;   // "always" replies write here
  readonly backend: string;
}
```

`allow` → dispatch; `deny` → typed `ToolDeniedByPolicy` result;
`ask` → the existing elicitation flow verbatim, with
`reply.always === true` routed to `learn()`. The bundled default,
`confirmationAnnotationsPolicy()`, reproduces current behavior
bit-for-bit — **zero behavior change until an adopter injects policy.**

### 6.2 Rules are data; the cascade narrows

`PolicyRule` / `PolicyDocument` (allow/deny/ask pattern lists over
tool + args; `matchesQuery` in utils-next is the matcher) are
serializable — storable in a JSON file (local pole), tenant rows
(cloud), editable over the wire by an admin surface. The *evaluator*
is resident; the *rules* travel. Config sources follow the dichotomy:
inline shorthand (`permissions: { allow, deny, ask }`) or configured
layered sources (`[managedPolicy(fromFile(...)),
projectPolicy(fromFile("./agentick.json")), learnedPolicy()]`).

**The policy cascade is deny-wins, narrowing-only** — an outer deny is
never widened by an inner allow; inner layers only restrict or add
asks. This is the *opposite* of every configuration cascade in the
framework (extension bridges, strategy overrides: inner-wins). It
needs its own merge primitive (`mergeNarrowing`, utils-next) —
**using `mergeLayered` here is a security bug wearing a house idiom.**
Stated side by side: *configuration cascades override inward; policy
cascades narrow inward.*

Effective policy is **compiled per execution** (the tools-per-tick
rhythm), cached, re-resolved on layer change. **Spawn inheritance
narrows**: children inherit the parent's effective policy and may only
restrict it — a sub-agent never out-permissions its parent.

### 6.3 Relationship to identity scopes

Shared: the verb-named vocabulary, the rule-document data types, the
matcher. One config document may carry both a `grants` section (→
Authorizer) and a `permissions` section (→ DispatchPolicy). **Not
shared: the gates.** "The user's client may call `session/send`" and
"the agent may run `rm -rf`" are different questions that merely rhyme;
this ADR forbids unifying them into one gate.

## 7. Provenance on Operation — facts, never decisions

`EventScope` gains the second core identity dimension (same
graduation argument as `principal`, ADR 48):

```ts
type OperationOrigin = "host" | "tree" | "model" | "inbox" | "wire" | "system";
// EventScope: readonly origin?: OperationOrigin;
```

Stamped **at the gates** (wire resolver stamps `wire`; registry inbox
path defaults `inbox`; tool dispatch stamps `model` — normalizing the
existing `context.via`; direct calls default `host`) and trusted
downstream, like `principal`. With subject (`principal`), verb
(`op.name`), target (`scope`), and causal chain
(`opId`/`parentOpId`/`correlationId`/`traceparent`, ADR 45) already on
the envelope, **the journal answers "who, via which gate, did what, to
what, as part of what" per envelope — the audit log costs one field.**

What does NOT go on Operation: any evaluation. No `requiredScope`
interpreted by harnesses, no authorize step in the phase contract —
doctrine (§4.1), hot path (46.8µs substrate budget; internal ops pay
nothing), and placement (static policy metadata lives on the
CommandDescriptor; per-instance provenance lives on the Operation).
**The registry names the required capability; the gates decide and
stamp; the scope carries evidence; the journal keeps the receipts.**

## 8. Implementation (the six changes)

> **Amendment — 2026-07-02 (slices 1+2 landed).** The error/policy
> types the slice-1 row lists (`AuthError`/`PermissionDenied`,
> `ToolDeniedByPolicy`, `PolicyRule`/`PolicyDecision`) land with their
> **consuming** slices (5 and 6 respectively), not ahead of them —
> the no-dead-code rule beats table fidelity. Slice 1 as landed:
> `CommandDescriptor`/`CommandExposure`/`CommandInfo`, `origin` on
> `EventScope` + `MessageEnvelope(Input)`, `CommandDeclarationError`.
> Command-payload validation failures reuse the existing registered
> `InvalidPayload` — no new error type was needed.

| # | Package | Change | ~LOC |
| --- | --- | --- | --- |
| 1 | spec | `CommandDescriptor` (+`exposure`), `origin` on `EventScope`, `AuthError`/`PermissionDenied`, `ToolDeniedByPolicy`, `PolicyRule`/`PolicyDecision` | 60 |
| 2 | runtime | `BaseHarness.command()` + registry dispatch step + `commands()` + meta-verb; `MessageEnvelope.origin?` | 100 |
| 3 | gateway | dynamic resolver on `WireExtensionRegistry` (explicit-beats-dynamic) + resolver fn with Authorizer gate + `commands/list`; `staticAuthorizer`/`permissiveAuthorizer` | 90 |
| 4 | tool-executor | `DispatchPolicy` port replacing the hardcoded gate; `confirmationAnnotationsPolicy()` default | 60 |
| 5 | utils | `mergeNarrowing` | 20 |
| 6 | harness packages | migrate switches → declarations; `WireMethods` augmentations | net-negative |

**Sequencing:** 1+2 first (independently valuable; timeline as
migration proof, right after A2.2). 3 ships **with** the Authorizer
(§4.3) and the matrix's exposure decisions. 4+5 self-contained,
default-invisible, any time. 6 opportunistic.

## 9. What this does NOT propose

- No global verb registry, no command-bus subsystem — per-instance
  registries + composition.
- No auto-exposure — `exposure` is per-verb opt-in by the harness
  author; grants are per-principal by the adopter.
- No unified authorization gate across the two subjects.
- No checks inside `runOperation`; no wire-side validation
  duplication.
- No policy engine beyond `staticAuthorizer` /
  `confirmationAnnotationsPolicy` — richer engines are adopter ports
  (ADR 34 for grant derivation).
- No hierarchical addressing.
- No deprecation of any existing wire method.

## 10. Open questions

1. **Verb naming for non-session-scoped targets** — `gateway:*` /
   `app:*` verbs take which params for target resolution? Pin with the
   matrix.
2. **`exposure` default** — `"addressable"` is proposed; confirm no
   harness has an internal-only verb that would leak via inbox before
   migration.
3. **Same-principal lookup cost** — target sessionId → owning
   principal requires a registry read at the gate; fine in-process,
   confirm the cluster-remote shape.
4. **Client proxy sugar** (`client.timeline(sessionId).compact()`) —
   post-`commands/list`, additive.
5. **Wire-visible schema discovery** for non-TS clients — additive via
   the meta-verb; needs demand.

## References

- ADR 27 amendment (2026-07-01) — behavior/projection doctrine, the
  verbs-not-configuration invariant this ADR generalizes
- `runtime/src/substrate/base-harness.ts` — dispatch chain, principal
  stamp (the pattern `origin` mirrors)
- `gateway/src/wire-registry.ts` — sealed registry the resolver extends
- `tool-executor/src/harness.ts:439–521` — the confirmation gate §6
  generalizes
- Knowify `assistant-api` auth plugin — reference adopter for ADR 34
  grant derivation
- Claude Code `settings.json` permissions — the capability-policy
  prior art (allow/deny/ask, layered, learned-local)
