# Materialization provenance — who put this in the timeline, and which version of them

**Status:** DESIGN — 2026-07-30, exploring with Ryan. Grew out of the
completions work: a chat UI showing a full rendered prompt as if the user
typed it (they typed `/quoting_report period:…`).

**Prior verdicts this builds on (do not re-litigate):** the op is the record;
provenance rides the artifact, never a parallel event stream; the timeline is
immutable and records what the model actually saw; presentation is the
client's call (capability, not opinion).

---

## 1. Problem

Definition libraries (prompts, skills — later resources, connector ingress,
paste expansion) **materialize** content into the timeline. Today the
materialized entries are indistinguishable from typed user input, which
breaks three consumers:

1. **Presentation.** A chat projection must show the wall of rendered text
   because it cannot tell "the user typed this" from "a prompt rendered
   this". The user typed a six-token slash command; they see 400 words.
2. **Audit.** "Which prompt produced this, at which version, with what
   arguments?" has no answer navigable from the entry. The `prompts:invoke`
   op journals `{ name, args }`, but nothing links the queued entries back
   to it — and nothing records which _revision_ of the declaration was live
   at execution time.
3. **Correlation.** "Did behavior change when the prompt changed?" requires
   joining sessions on the version of the definition used. No such key
   exists.

### The wrong fixes, refuted

- **Reference-only timeline entries** (store `{ ran: name, args }`,
  re-render at compile): breaks what-the-model-saw. Edit the prompt and
  history silently rewrites; restore without the render fn and history has
  holes. The timeline keeps full materialized content, immutably, as-sent.
- **A commands seam / parallel "command was run" event stream**: the
  `prompts:invoke` operation already IS that record, journaled with input
  and terminal. A second record is a second source of truth.
- **Client-side collapse heuristics** (regex the message, hide long ones):
  provenance by vibes. No.

## 2. The mechanism already half-exists

`MessageMetadata` documents the **`metadata.source` convention**: messages
entering a session from elsewhere carry their origin under `metadata.source`,
typed against the module-augmentable `MessageSource` empty-seed interface
(spec `data/entries.ts`, ADR 58 — deliberately an open-bag key so no
provenance concept is hardcoded into the foundational message shape).
Connectors were the first tenant. Prompts and skills claim their slots the
same way (ADR 27: each package owns its augmentation).

## 3. The stamp — only what the framework already holds

**The razor (Ryan, 2026-07-30): the framework stamps only facts it already
holds at the moment it acts, at zero derivation cost. Everything beyond that
is exported tooling, not policy.** We do not care whether an adopter stores,
versions, or audits anything — we make it possible, not mandatory.

Each materializing package augments `MessageSource` with its variant. The
stamp is exactly what `applyInvoke` has in hand when it queues:

```ts
// variant shapes (each package's own augment.ts):
{ kind: "prompt"; name: string; args?: Record<string, unknown>; opId: string; version?: string }
{ kind: "skill";  name: string; opId: string; version?: string }
```

- `opId` — the materializing operation (`prompts:command:invoke`), the
  navigable link entry → journal. Already minted.
- `args` — duplicated from the op input on purpose: the pill renders from
  the TIMELINE on a client that does not hold the journal. Already present
  in the rendered content; no new exposure. Already in hand.
- `version` — the declaration's own optional field (below), copied verbatim
  from the record the invoke just looked up. In hand; zero derivation.
- No hashing, no computed fields, no extra record lookups at stamp time.

**`version?: string` is a DECLARED optional field on the declaration/record**
(prompts and skills; ratified with Ryan 2026-07-30 — promoted from the
earlier metadata-bag convention). Adopter-defined, never framework-computed,
absent by default. Serializable, so it rides the record everywhere it
already goes (`list`, snapshots, client handles) with no new plumbing. Set
nothing and everything works minus the version string — the adopter's only
decisions are whether to set it and how to project it.

**Prompts.** `applyInvoke` stamps every entry it queues (merge into existing
entry metadata, never clobber). `render`/`get` (non-queueing) do NOT stamp —
nothing entered the timeline.

**Skills.** Same shape when skill content materializes into the timeline.

**Later, unchanged pattern:** resource reads inlined into context, connector
ingress (already stamps `source` — the founding tenant), paste/attachment
expansion.

## 4. The optional toolkit — versioning for whoever wants it

For the adopter with an audit or correlation requirement, three tools —
none of which the framework invokes on its own behalf:

1. **`version?: string`** — the declared field per §3: the adopter sets it
   (or doesn't); the framework only copies it into the stamp. What the
   string MEANS (semver, deploy hash, date) is entirely theirs.
2. **A record-hash helper.** One exported function (home:
   `@agentick/utils` — grep for an existing stable-hash first):
   canonicalized JSON → truncated sha-256 of a record slice. Call it at
   whatever point you consider "the version that ran" and put it wherever
   you like. The framework never calls it.
3. **The journal itself.** Declaration mutations (`register`/`update`) are
   already journaled ops carrying the full record — "which revision was
   live at time T" is answerable today by anyone retaining the journal,
   with zero new machinery. The stamp's `opId` gives the join point.

What is NOT provable by anyone, honestly: the render fn's **code**. A
closure cannot be meaningfully hashed; the rendered OUTPUT is already inline
and immutable in the entry, and code identity is the adopter's supply-chain
concern (tier 1 above). We refuse to manufacture confidence here.

## 5. The runnable taxonomy — this is not just prompts

Everything a composer can run, what records it, and what stamps it. The
column that matters: **none of these needs a commands seam** — each already
has (or gets) its record from an existing primitive.

| Runnable                        | Client verb                             | The record (journal)               | What enters the timeline        | Stamp                                               |
| ------------------------------- | --------------------------------------- | ---------------------------------- | ------------------------------- | --------------------------------------------------- |
| **Prompt** (composes context)   | `session.prompts.invoke({name,args})`   | `prompts:command:invoke` op        | rendered messages               | `kind: "prompt"` (§3)                               |
| **Skill**                       | skills invoke/load verb                 | skills op                          | skill content                   | `kind: "skill"` (§3)                                |
| **Tool** (does something)       | `session.dispatch({tool,input})`        | tool dispatch through the executor | tool-call / tool-result entries | likely NONE NEEDED — see below                      |
| **Local command** (client-side) | app-land handler (ernesto LocalCommand) | none (never reaches the session)   | whatever it chooses to `send`   | app-land `MessageSource` variant — the seed is open |

**Tools are the already-solved half.** Tool-call/result entries are
_structurally_ provenance-bearing — name, input, `toolCallId` — which is why
chat UIs already collapse them ("2 tool calls"). A user-dispatched tool needs
no new stamp; the dispatch op is its record. What it lacks is the
**composer-side projection**, three concrete gaps:

1. **`flatArgsOf(inputSchema)`** — project a tool's JSON-Schema input into
   the flat named-slot list a composer renders as typed params (the same
   descriptor shape prompt arguments already have). Non-flat schemas project
   partially or opt out; honest degradation, not magic.
2. **Palette enumeration** — which tools are user-runnable = the
   dispatch-exposed subset, projected to the client the way
   `prompts:list` projects declarations. (Verify what `session/list_tools`
   exposes today and whether exposure filtering is applied.)
3. **Argument completion** — `ref: { type: "tool" }` on the
   `completions/complete` verb, the additive arm §6 of completions.md
   reserved. Same seam, same builders, same composer slots.

**Local commands stay app-land** (recorded verdict), but the provenance
convention still serves them: `MessageSource` is an open seed, so an app may
declare its own variant (`kind: "local-command"`) and stamp messages its
handlers send. The framework ships the convention, not the catalog.

## 6. The client flow this completes (Knowify/ernesto)

On slash-command submit the composer calls
`session.prompts.invoke({ name, args })` instead of composing text
client-side and pushing it through `timeline.send` — the client stops
holding prompt content entirely (declaration records from `prompts:list`
suffice; the render fn never leaves the server). The chat projection then
discriminates `entry.metadata.source.kind`:

- `"prompt"` → pill: `/quoting_report period:2026-01…` — expandable to the
  full content already in the entry; "inspect" in devtools follows `opId` /
  `ref.revision` into the journal.
- absent → the user typed it; render as today.

**Open ergonomics question (decide against the composer's real submit
flow, P4):** after `invoke()` queues, what kicks the run — a trailing
`session.send` with follow-on text, an empty-send trigger, or a
`run: true` option on invoke.

## 7. Deliberately not doing

- No reference-only entries; no retroactive re-render (§1).
- No parallel provenance event stream; the op + the stamp are the record.
- No framework-computed versioning of any kind (§3 razor / §4): no
  framework-maintained `revision` field on records, no automatic hashing,
  no code versioning. All of it is the adopter's call, served by the
  toolkit.
- No `audience` prop resurrection — visibility of the pill is a projection
  decision, not an entry property.
- No new package: per-package `MessageSource` augmentations + write-site
  stamps + one utils helper.

## 8. Phasing

- **A (agentick):** `MessageSource` prompt variant (`kind`/`name`/`args`/
  `opId`); `applyInvoke` stamps queued entries. Tests: stamp present on
  queued, absent on render/get, metadata merged not clobbered, opId matches
  the invoking op.
- **B (agentick):** skills variant at its materialization site; the
  record-hash helper in `@agentick/utils` (grep for an existing stable-hash
  first) + the `metadata.version` convention documented where declarations
  are documented.
- **C (Knowify):** composer submit → `prompts.invoke`; chat pill projection;
  the run-trigger ergonomics decision.

Every claim lands with a test or lives in a "Roadmap & known gaps" section.
