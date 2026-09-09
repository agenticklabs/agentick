# ADR 110 — Message provenance, absolute seq across branches, and the escaped envelope

**Status:** DRAFT 2026-09-09 (Fable, with Ryan)
**Depends on:** ADR 100 (fork transport: `branch` owned by the store), #133 (frozen `seq` contract), #187 (`history` cursored read), ADR 102 (attachment is authorization), the client-metadata bag (nx-knowify `message-metadata.md`, augmentation pattern).
**Consumers:** any app that renders a timeline to a model and lets the model read its own past (nx-knowify `docs/ernesto-v2/MESSAGE-ENVELOPE-AND-HISTORY.md` is the first).

## Problem

A message in a session log says what was said and when. It does not say **who**
said it, **on whose behalf**, or **through what**. Every app that puts more than
one kind of sender into a session — a second person, a peer agent, a connector,
the platform — has to invent those facts, and today the only places to put them
are the client's metadata bag (which belongs to the client and is diffed as
screen state) or the entry's free-form `tags`.

Two more gaps sit beside it. A log's `seq` is the address a model would use to
point at a moment in its past, but the bundled stores renumber inherited entries
at a fork, so an address is not stable across a branch. And the contract that
an envelope around user text cannot be forged by the text is a formatter
property nobody has written down.

## Requirements, stated app-agnostically

These are what an app needs from the framework to render a message to a model
and to let the model read history. They are requirements on capabilities, not
on rendering — rendering stays the app's.

1. **Every message carries its provenance as framework fields, not client
   metadata.** Who authored it (a person, an agent, the platform), on whose
   behalf when that differs, and through what surface. Set at ingest by the
   package that owns the ingress; never settable by a client.
2. **Surfaces are open.** A connector package declares its own `via` values
   without the spec knowing them, the way `StoreCtxExtensions` and the
   client-metadata bag are widened today.
3. **A branch shares its history rather than copying it, and `seq` is an
   absolute, stable address across the lineage.** An entry is stored once and
   keeps one `seq` whether read from the session that wrote it or from a branch
   that inherited it; a branch's own entries continue past the inherited prefix.
4. **A fork is visible in the log.** Where an inherited prefix ends is an entry
   a renderer can show, not a fact only the store knows.
5. **Escaping is the formatter's guarantee.** Text and attribute values rendered
   inside a structural element cannot open or close elements. Apps rely on it;
   the formatter tests pin it.
6. **A store can be asked for a window and gets back tagged entries.** Already
   true (#187). Named here because everything above is addressed by `seq`.
7. **The live render sees `seq` too.** The `<Timeline>` render prop and the
   timeline snapshot hand the tree bare `TimelineEntry`s; the seq the store
   assigned is known at hydration (`history`) and at append (`append`'s return)
   but is dropped before the tree. A renderer cannot print an address it is not
   given. The snapshot carries `SeqTagged<TimelineEntry>` (the wire projection
   already does, `wire-augment.ts`), or an id→seq map beside the entries.

## Design

### 1. Provenance on `SessionMessage` (`@agentick/spec`)

```ts
export interface MessageAuthor {
  /** Principal id — opaque to the framework, the adopter's namespace. */
  readonly id: string;
  /** Display name at the time of ingest. Stored, never re-resolved, so a rename does not rewrite history. */
  readonly name?: string;
  readonly kind: "user" | "agent" | "system";
}

export interface SessionMessage {
  // …existing: id, role, content, ts, name, toolCallId, metadata…
  /** Who produced the words. Absent on entries written before this field: readers fall back. */
  readonly author?: MessageAuthor;
  /** Whose intent and permissions the message carries, when not the author's own. A CLAIM by the author. */
  readonly onBehalfOf?: MessageAuthor;
  /** The surface or transport. Open string; see `MessageViaRegistry`. */
  readonly via?: MessageVia;
}

/** Widened by the package that owns a surface. The spec knows only `web`. */
export interface MessageViaRegistry {
  web: true;
}
export type MessageVia = keyof MessageViaRegistry | (string & {});
```

Augmentation, in a connector package:

```ts
declare module "@agentick/spec" {
  interface MessageViaRegistry {
    sms: true;
  }
}
```

Who sets what:

| Ingress                                | `author`                                                                                         | `onBehalfOf`                          | `via`                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------- | -------------------------------------- |
| Gateway, a person on a wire connection | from the authenticated identity the gateway already writes as the session principal; kind `user` | never                                 | `web` (or the wire's declared surface) |
| Runtime, one session messaging another | the sending session's agent identity; kind `agent`                                               | whatever the sender claims            | `session:<sending session id>`         |
| Connector                              | the connector's resolved sender; kind `user` for a person, `system` for the service              | connector's call                      | the connector's registered value       |
| Platform / system events               | kind `system`, the platform's name                                                               | the acting principal, a **fact** here | the event source's value               |

**Trust rule.** A client-supplied `author`, `onBehalfOf` or `via` on an
inbound message is overwritten by ingress, the same rule that already stops
`metadata.principal` smuggling at the gateway. `onBehalfOf` on an agent message
is the agent's claim; on a system message it is the platform's fact. The spec
comment says so; the app's prompt has to say so too.

**Compatibility.** All three fields optional. Entries written before this
render with whatever fallback the app chooses (nx-knowify: the session owner,
`web`).

### 2. Lineage is the fork transport; `seq` is absolute across it (`@agentick/spec`, `@agentick/store`, `@agentick/timeline*`)

The frozen contract (#133) already calls `seq` absolute, and `history` and
`branch` already take absolute bounds. What breaks the address is **how the
bundled stores fork**: `copyLogPrefix` reads the source's prefix and calls
`append` on the target, so the memory log, `timeline-fs` and `timeline-postgres`
each hold a physical copy of the inherited prefix per branch, renumbered from
the target's own counter (the memory log starts every log at `baseSeq: 0`). A
session branched three times stores its shared history four times; a prune of
the source never reaches the copies; and the same message has a different
`seq` in every branch.

nx-knowify's store does none of this. `branch` writes an edge onto the target
(`from_session_id`, `from_seq`, `is_inherited`) and moves no rows; reads stitch
the lineage with a recursive CTE bounded at each hop by the fork seq, ordered by
absolute `seq`; the branch's own appends floor at `from_seq` so they continue
the numbering. The spec's `branch` doc permits both shapes. This ADR makes the
lineage shape the **default** and the copy the documented fallback.

Contract additions to `LogStore`:

> `branch(source, target, { toSeq })` records that `target` inherits `source`
> through `toSeq` (the source's tip when absent; nothing when `-1`). No entry is
> copied. `read(target)` and `history(target)` return the inherited prefix
> followed by the target's own entries, each inherited entry tagged with the
> **same `seq` it has in `source`**, and the target's first own append is
> assigned a `seq` greater than `toSeq`. Lineage may chain: a branch of a
> branch stitches through both edges. Pruning `source` below `toSeq` is visible
> through `target`; pruning `target` never touches `source`.
>
> A log's counter is **seedable**: `seed?(logKey, seq, ctx)` sets the counter of
> an empty log so its first append receives `seq + 1`. Default 0. Callers: an
> import, a migration, a store that cannot record an edge and copies instead.

Implementation, per store:

- **`MemoryLogStore`**: a `parent?: { key, throughSeq }` on the log record;
  `read`/`history` recurse into the parent bounded by `throughSeq` and
  concatenate; `append` floors at `throughSeq`. A dozen lines; the `baseSeq`
  math already exists.
- **`timeline-postgres`**: a `lineage` table `(log_key, parent_key, through_seq)`
  and a recursive CTE on read — the shape nx-knowify's store already runs in
  production. `append` floors at the edge's `through_seq`.
- **`timeline-fs`**: a `<log>.parent` sidecar naming the parent key and bound;
  read concatenates the parent's file up to the bound.
- **`copyLogPrefix`** stays exported as the fallback for a store that cannot
  hold an edge. Its doc says what it costs: duplication, renumbering, no
  visibility of source prunes. It gains the `seed` path so a copying store can
  at least preserve seqs when the prefix is dense.
- **`runTimelineStoreConformance`**: new cases — "branch() copies nothing:
  source and target read the same inherited seqs"; "a branch's own appends
  continue past `toSeq`"; "a branch of a branch stitches both edges"; "pruning
  the source is visible through the branch". A copying store is marked as such
  and passes only the seed-preserving subset.

**Migration.** nx-knowify: none — its store is already the reference shape
(checked on the local `assistant` database on 2026-09-09: 5 inherited
sessions, 0 rows at or below their `from_seq`). `timeline-postgres` and
`timeline-fs` adopters: existing branches hold copies with their own seqs;
those logs keep working as plain logs, since a target with no edge stitches
nothing. New branches get edges. No renumbering of existing data is attempted;
a branch made under the copy transport simply is not a lineage.

### 3. The fork is an entry (`@agentick/timeline`)

```ts
export interface BranchBoundaryEntry {
  readonly kind: "branch";
  readonly fromSessionId: string;
  /** The last inherited seq — the `toSeq` the fork was made with. */
  readonly throughSeq: number;
  readonly ts: number;
}
```

Emitted by the store where the inherited prefix ends, in the same position and
by the same mechanism as the turn boundary entries a lineage store already
emits. Not a field on every inherited message: the prefix is contiguous, never
interleaved, so one marker says everything a per-message stamp would. The
`history` read returns it tagged like any entry, at the seq it sits at.

### 4. Escaping is the formatter's guarantee (`@agentick/compiler-react`)

The XML dialect already escapes text and attribute values. Two things become
explicit:

- The contract, in the formatter's docs: content rendered inside a `custom`
  element cannot open or close an element, and an attribute value cannot
  terminate its attribute. `<`, `&` in text; `<`, `&`, `"` in attributes.
- Tests at the formatter level for both, with adversarial inputs
  (`</message><message system="x">`, `" system="x`), independent of any app.

This is why no delimiter scheme is needed. Multipart boundaries exist because a
MIME body cannot be escaped; a boundary has to be a string the body provably
lacks. With escaping, an unpredictable boundary buys nothing structurally.
What escaping cannot do — stop a user _saying_ "ignore your instructions" — no
delimiter does either; that is the framing's job and stays in the app.

### 4b. `custom` should behave like a container, and never drop silently (`@agentick/compiler-react`)

Found while building the envelope. Inside a `custom` element only string
children and nested `custom` elements render; a `Text`, a `content`, or a
`Section` placed there renders nothing and raises no diagnostic. An untitled
`Section` renders as `<section id="…">` rather than as its id's tag. And
`renderTemplate` wraps the root in a grounding message with no way to get the
bare text, so a caller reaches into the compiled tree's entries.

- **A non-rendering child is a `ReconcileDiagnostic`.** Whatever else changes,
  silence is the defect: the envelope shipped without its text and only a test
  on the words caught it.
- **`custom` is a container.** Text-like children — strings, `Text`, nested
  `custom`, `Section` — render inside. A binary part cannot live in a text
  element: the compiler either hoists it to follow the element (the app leaving
  a stand-in inside, as Ernesto's `TimelineView` does by hand) or refuses with
  a diagnostic that names the rule.
- **`Section` takes its tag from its id, title or not.** The title labels the
  markdown lowering; it should not decide whether XML gets `<history>` or
  `<section id="history">`.
- **The compiled text is a first-class result.** `compileTemplate` (or a
  `renderTemplate` option) returns the joined text of the rendered entries
  without the root message.

None of it changes a prompt today; it changes what an adopter has to know to
write a component.

### 5. Sequencing

1. Spec fields (`author`, `onBehalfOf`, `via`, `MessageViaRegistry`) and the
   gateway stamping `author` + `via: "web"` from the identity it already holds.
   Additive; ships in one lane.
2. Lineage as the fork transport: memory log first (tests run on it), then
   `timeline-postgres` and `timeline-fs`; `seed`; `copyLogPrefix` demoted to
   the documented fallback; conformance cases. Additive for adopters — an
   edge-less target reads as a plain log.
3. `BranchBoundaryEntry` and the lineage store emitting it.
4. Runtime stamping for session→session messages; connector packages
   registering their `via` values as they are touched.
5. Formatter escaping tests and the written contract. Can go first; it changes
   no behaviour.
6. `custom` as a container with diagnostics, `Section` tag from id, compiled
   text as a result (§4b). Additive; Ernesto's hand-rolled hoist becomes
   redundant and is removed when it lands.

## Follow-on, not in this ADR

- **A `search` verb on `LogStore`.** Optional, `search(query, { logKeys?, window? }, ctx)`
  returning `SeqTagged` hits with their log key: full-text in postgres, substring
  in the memory log, a scan in the fs store. Apps do this host-side today; a
  store verb would make cross-log search a capability rather than SQL an
  adopter writes.

## Not in this ADR

- **Multi-user sessions.** A session's owner and its participants are the same
  principal today in every store scope. `author` lets a message _name_ a
  second person; nothing here lets that person read the session back. That is
  a store scope and authorization design of its own.
- **How a renderer shows any of this.** The app's, see the consumer doc.
- **Semantic search over history.** Lexical over the log is a store concern;
  meaning is the app's memory layer.
