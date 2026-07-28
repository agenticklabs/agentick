# @agentick/timeline

## 1.0.0-next.19

### Minor Changes

- The last N entries of a log are readable. "Open this thread on its most
  recent 20 messages" — the first read every chat UI performs — had no
  expression anywhere in the framework: `LogQuery` and `history` took a
  lower bound only, and the same lower-bound-only shape was mirrored at
  every layer above (the `timeline/history` payload, the harness face, the
  client handle). The first real consumer paid for that absence four
  times over: it paged FORWARD from the log's head accumulating up to 25
  pages to find the tail, kept its own mirrored copy of the window to do
  it, re-seeded the handle from that copy (clobbering live appends), and
  its scroll-UP affordance loaded NEWER entries.

  The window is now `{ fromSeq?, toSeq?, limit? }` — one named
  `LogHistoryOptions` shared by the port, the harness, and the wire
  payload, so the shape cannot drift between them. Both bounds are
  inclusive and `limit` truncates **from the end the query anchored at**:
  declare a `fromSeq` and you get the first `limit` (forward paging,
  unchanged); declare none and you get the last `limit` at or below
  `toSeq`, defaulting to the log's tail. Rows always come back ascending
  by `seq`. Adapters implement the reverse slice once (`MemoryLog`,
  `timeline-fs`, `timeline-postgres` — `ORDER BY seq DESC LIMIT n`,
  re-ascended), which is why this belongs at the port rather than being
  re-solved per adapter; the conformance suite certifies it.

  Above it: `timeline/history` replies now carry the cursor that continues
  the direction asked in (`nextFromSeq` forward, `nextToSeq` backward), and
  `session.timeline.loadOlder()` is a TRUE tail-anchored backward pager —
  it opens on the log's newest page, walks down by `nextToSeq`, and splices
  each page at the head, so page two lands above page one and scroll-back
  needs no app-side mirror, re-seed, or re-sort. `hydrateTail(n)` is now
  one round-trip instead of a `ceil(N / page)` forward seek.

  BREAKING for callers that read a bare `{ limit: n }`: that used to mean
  the log's FIRST n and now means its LAST n. Forward paging declares its
  lower bound — `{ fromSeq: 0, limit: n }`.

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.19
  - @agentick/compiler@1.0.0-next.19
  - @agentick/compiler-react@1.0.0-next.19
  - @agentick/pubsub@1.0.0-next.19
  - @agentick/runtime@1.0.0-next.19
  - @agentick/spec@1.0.0-next.19
  - @agentick/store@1.0.0-next.19
  - @agentick/utils@1.0.0-next.19

## 1.0.0-next.18

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.18
  - @agentick/compiler@1.0.0-next.18
  - @agentick/compiler-react@1.0.0-next.18
  - @agentick/pubsub@1.0.0-next.18
  - @agentick/runtime@1.0.0-next.18
  - @agentick/spec@1.0.0-next.18
  - @agentick/store@1.0.0-next.18
  - @agentick/utils@1.0.0-next.18

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.17
  - @agentick/compiler@1.0.0-next.17
  - @agentick/compiler-react@1.0.0-next.17
  - @agentick/pubsub@1.0.0-next.17
  - @agentick/runtime@1.0.0-next.17
  - @agentick/spec@1.0.0-next.17
  - @agentick/store@1.0.0-next.17
  - @agentick/utils@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.16
  - @agentick/compiler@1.0.0-next.16
  - @agentick/compiler-react@1.0.0-next.16
  - @agentick/pubsub@1.0.0-next.16
  - @agentick/runtime@1.0.0-next.16
  - @agentick/spec@1.0.0-next.16
  - @agentick/store@1.0.0-next.16
  - @agentick/utils@1.0.0-next.16

## 1.0.0-next.15

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.15
  - @agentick/compiler@1.0.0-next.15
  - @agentick/compiler-react@1.0.0-next.15
  - @agentick/pubsub@1.0.0-next.15
  - @agentick/runtime@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/store@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Minor Changes

- ADR 93 D2 — the client read door. `timeline:history` is now a DECLARED
  wire-exposed command on the harness (`exposure: "wire"`): the dynamic lane
  projects it as `timeline/history`, admission is the existing two-step
  (deny-by-default exposure, then a grant on the `timeline:history` scope
  label, same-principal target rule), and the payload/result are fully
  serializable — a seq-cursored page with `nextFromSeq` present iff the page
  was capped (sparse-seq safe: `lastSeq + 1`, a lower bound, never a claim).
  Reads are a journaling CLASS: `timeline:command:history` is bus-only by
  default (observable live, never durable), and an adopter `policy` layers
  over the class per-key. The in-process `history()` face runs the same
  command body — hooks and guards fire on both paths. Client:
  `session.timeline.history()` is the raw stateless page (Posture B pages
  straight into its own store); `loadOlder()` is its cursor-tracking
  scroll-back sugar, spliced at the window head. Wire rows moved to a
  type-only `wire-augment.ts` so the browser subpath types the door without
  loading server-bridge augmentations. The old `session/timeline_history`
  gateway porcelain is superseded (deletion queued with its spec rows).

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.14
  - @agentick/compiler@1.0.0-next.14
  - @agentick/compiler-react@1.0.0-next.14
  - @agentick/pubsub@1.0.0-next.14
  - @agentick/runtime@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/store@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Minor Changes

- ADR 93 D1 — the namespace-definition proving instance. `defineTimeline`
  (identity + non-enumerable brand; the definition IS the options, inert
  until per-session install) and `defineTimelineStore` (the port's typed
  inline constructor with a derived query/mutate seam and loud failure on
  un-answerable cursor queries). The genesis seam: `hydrate(ctx)` with a
  typed `ctx.store` facet; named hydrators `hydrateFromStore()` (default —
  ADR 49 open-or-rehydrate preserved) and `hydrateTail(n)`; the genesis
  laws enforced and tested — seed-never-append, fork/spawn never re-runs
  genesis, a throwing hydrator fails session creation typed.
  `compact(entries, ctx)` definition sugar over CompactStrategy.
  `hooks:`/`guards:` bags with drop-layer naming; the interceptor cascade
  is now TOTAL at every host tier (app + gateway + session installers
  thread the handle — app-level guards wrap every namespace).
  `createApp({ timeline })` top-level slot via augmentation + side-effect
  slot registration. Deleted: `WithTimelineOptions.initial`,
  `rehydrateStrategy`/importSnapshot-as-resume. §2.7: the in-memory
  persisted tier is gone — bounded hydration really loads N.

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.13
  - @agentick/compiler@1.0.0-next.13
  - @agentick/compiler-react@1.0.0-next.13
  - @agentick/pubsub@1.0.0-next.13
  - @agentick/runtime@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/store@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.12
  - @agentick/compiler@1.0.0-next.12
  - @agentick/compiler-react@1.0.0-next.12
  - @agentick/pubsub@1.0.0-next.12
  - @agentick/runtime@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/store@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.11
  - @agentick/compiler@1.0.0-next.11
  - @agentick/compiler-react@1.0.0-next.11
  - @agentick/pubsub@1.0.0-next.11
  - @agentick/runtime@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/store@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.10
  - @agentick/compiler@1.0.0-next.10
  - @agentick/compiler-react@1.0.0-next.10
  - @agentick/pubsub@1.0.0-next.10
  - @agentick/runtime@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/store@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.9
  - @agentick/compiler@1.0.0-next.9
  - @agentick/compiler-react@1.0.0-next.9
  - @agentick/pubsub@1.0.0-next.9
  - @agentick/runtime@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/store@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.8
  - @agentick/compiler@1.0.0-next.8
  - @agentick/compiler-react@1.0.0-next.8
  - @agentick/pubsub@1.0.0-next.8
  - @agentick/runtime@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/store@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.7
  - @agentick/compiler@1.0.0-next.7
  - @agentick/compiler-react@1.0.0-next.7
  - @agentick/pubsub@1.0.0-next.7
  - @agentick/runtime@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/store@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.6
  - @agentick/compiler@1.0.0-next.6
  - @agentick/compiler-react@1.0.0-next.6
  - @agentick/pubsub@1.0.0-next.6
  - @agentick/runtime@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/store@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.5
  - @agentick/compiler@1.0.0-next.5
  - @agentick/compiler-react@1.0.0-next.5
  - @agentick/pubsub@1.0.0-next.5
  - @agentick/runtime@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/store@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.4
  - @agentick/compiler@1.0.0-next.4
  - @agentick/compiler-react@1.0.0-next.4
  - @agentick/pubsub@1.0.0-next.4
  - @agentick/runtime@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/store@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.3
  - @agentick/compiler@1.0.0-next.3
  - @agentick/compiler-react@1.0.0-next.3
  - @agentick/pubsub@1.0.0-next.3
  - @agentick/runtime@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/store@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.2
  - @agentick/compiler@1.0.0-next.2
  - @agentick/compiler-react@1.0.0-next.2
  - @agentick/pubsub@1.0.0-next.2
  - @agentick/runtime@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/store@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
