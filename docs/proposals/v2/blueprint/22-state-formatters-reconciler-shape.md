# ADR 22 — StateBridge + Formatters

> **Rename note (2026-07-21, #243):** the "reconciler" subsystem referenced below was renamed to **compiler** — `@agentick/reconciler-next` → `@agentick/compiler-next`, `@agentick/reconciler-react-next` → `@agentick/compiler-react-next`, `ReconcilerProtocol` → `CompilerProtocol`, `ReconcilerHarness` → `CompilerHarness`, etc. Original terminology is preserved below as historical record.

**Status:** Accepted — 2026-05-19
**Modifies:** `04-formatter-harness.md` (rename → `04-formatters.md` with a
rewrite that aligns to v1's shape).
**Driver:** Close out hibernate-and-resume state persistence and the
formatter layer. Adopt v1's proven shapes; resist re-inventing them.

## Context

Two outstanding gaps blocked further work, and a third question
(reconciler-core extraction) wanted a decision:

1. **State persistence.** `ReconcilerSnapshot.hookStates` was specced as
   "walk React fibers." V1 doesn't do that — `fiber-compiler.ts:636`
   hardcodes `hooks: []`. V1 persists the COM state bag and rebuilds the
   fiber tree from JSX. v2 needs the same.
2. **Formatter layer.** `FormatterHarnessProtocol` (commands, events,
   middleware, lifecycle) was over-spec'd. V1 already proved a
   pure-function shape works.
3. **Reconciler-core extraction.** Considered splitting reconciler-react
   into core + driver in anticipation of an Angular reconciler.

## Decisions

### D1 — StateBridge (sibling of KnobBridge, NOT collapsed)

```ts
interface StateBridge {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  list(): readonly string[];
  subscribe(key: string, listener: () => void): Unsubscribe;
  exportSnapshot(): Readonly<Record<string, unknown>>;
  importSnapshot(values: Readonly<Record<string, unknown>>): void;
}
```

- Required field on `HookBridges` — every reconciler ships one.
- Owned by the session across mounts (survives re-mount).
- Persisted via the existing session snapshot path.
- React hook surface: `useSessionState<T>(key, initial)` — same `useSyncExternalStore` pattern as `useKnob`.

**Why not collapse into KnobBridge.** The model-facing `set_knob` tool is a
consumer of knobs. Sharing storage with internal state would force the
executor to filter knobs.list() output on every dispatch — leaking bridge
internals into the executor. Different consumer contracts, different
interfaces.

**v1 mapping:** `useComState(key, initial)` becomes `useSessionState(key, initial)`. Storage moves from COM to StateBridge. Semantics are identical.

### D2 — Formatters are v1-style pure functions (sidecar pattern preserved)

Adopt v1's proven shape from `packages/core/src/renderers/base.ts`:

```ts
// In @agentick/spec-next/data/formatter.ts (already mostly there)
type Formatter = (blocks: readonly SemanticContentBlock[]) => readonly ContentBlock[];

// In @agentick/spec-next/data/semantic.ts — KEEP the sidecar
type SemanticContentBlock = ContentBlock & {
  readonly semanticNode?: SemanticNode;
};

interface SemanticNode {
  readonly text?: string;
  readonly semantic?: SemanticType;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly SemanticNode[];
  readonly rendererRef?: FormatterRef; // v2's spec-firewall replacement
  // for v1's `formatter: Formatter`
}
```

- Wire-level ContentBlock types **unchanged**. `TextBlock.text: string` stays.
- Sidecar (`semanticNode?: SemanticNode`) is optional metadata that JSX
  contributors set when they encounter semantic HTML (`<strong>`, `<h1>`,
  `<ul>`, etc.). Model output and tool output don't set it.
- Formatter walks the input array. When a block has a `semanticNode`, the
  formatter resolves the tree to formatted text and emits a TextBlock with
  the resolved string. Other blocks pass through.
- Nested formatter switching via `SemanticNode.rendererRef` — the
  reconciler resolves the ref against its formatter registry.

**`createFormatter` exported from `@agentick/formatters-next`** (per [ADR 36](36-define-vs-create-convention.md) — formatters need no parent-substrate, so the verb is `create`):

```ts
interface CreateFormatterInput {
  readonly id: string;
  readonly format: "markdown" | "xml" | "text" | "json" | (string & {});
  readonly version?: string;
  readonly render: Formatter;
}

function createFormatter(spec: CreateFormatterInput): Formatter;
```

**Reference formatters** ship as functions, no harness wrapping:

- `@agentick/formatter-markdown` — `createFormatter({...})` export
- `@agentick/formatter-xml`
- `@agentick/formatter-text`

**Markdown is the default** when no `<XML>` / `<Markdown>` / `<PlainText>`
scope provider pins one. Models are trained on markdown-heavy corpora; this
is the path of least surprise.

**Where the formatter runs:** during the reconciler's fold step. The
walker builds up `SemanticContentBlock[]` (with sidecars where applicable),
the fold invokes the active formatter, the result is wire-ready
`ContentBlock[]` that lands in `MessageEntry.content` /
`SectionEntry.content`. By the time `RenderedTree` materializes, nothing
downstream sees SemanticNode.

### D3 — Defer reconciler-core extraction

Do not split `@agentick/reconciler-react-next` into core + driver packages now.
Refactor when a second concrete reconciler arrives (Angular, Solid) to force
the boundary. Speculative extraction guesses wrong; refactoring against a
real second consumer guesses right.

## Consequences

- StateBridge closes `ReconcilerSnapshot.hookStates` as a real design item.
  Remove that field from the spec.
- Formatter implementation is small: three function packages, one new slot
  on the reconciler, delete the private `serializeTreeToString` helper.
- v1 wire-compat is the identity function for text content.
- Spec doc `04-formatter-harness.md` → `04-formatters.md` rewrite.
- Reconciler-react owns the formatter registry, the fold step, and
  `createFormatter`. Core extraction is deferred.

## Implementation order

1. **StateBridge** — spec types, in-memory ref impl, `useSessionState` hook,
   session wires it across mounts, snapshot round-trip test. Drop
   `ReconcilerSnapshot.hookStates`. (~half day)

2. **Formatters + `createFormatter` + markdown default** — wire the
   formatter registry slot, build the three reference formatters, swap out
   the private `serializeTreeToString`. Rewrite `04-formatters.md`.
   (~1 day)

3. **Semantic HTML contributors** — `<h1>`–`<h6>`, `<p>`, `<ul>`/`<ol>`/
   `<li>`, `<strong>`/`<em>`/`<code>`/`<a>`, `<table>` family,
   `<blockquote>`, `<hr>`, `<br>`, `<pre>`. Each emits SemanticNode into
   the surrounding TextBlock's `semanticNode` sidecar. Per-format
   handlers in each formatter. (~2 days)

4. **AI SDK example scenario** — independent. (~1 hour)

Total: ~3.5 days.

## Discarded alternatives

**A — Walk React fibers for hook-state capture.** v1 doesn't do this. StateBridge mirrors v1's COM pattern; mechanically simpler, framework-portable, no react-reconciler internals coupling.

**B — Collapse StateBridge into KnobBridge with visibility flag.** Different consumer contracts (model-facing tool vs framework-internal). Sharing storage couples executor to bridge internals.

**C — Formatter as harness.** Over-spec'd. v1's pure-function shape works; harness wrapping is bureaucracy with no load-bearing capabilities the formatter actually uses.

**D — `TextBlock.content: string | SemanticNode[]` (union on wire).** Pollutes the wire type with a representation only the reconciler cares about. Adopts the sidecar pattern instead.

**E — Drop the sidecar; require formatter to output flat strings only.** Loses the ability to mix native ContentBlocks (images, audio) with formatted text in one pass. v1's `Formatter` returns `ContentBlock[]` precisely so mixed-content stays composable.

**F — Extract `@agentick/reconciler-next` core now.** Sandi Metz / Kent Beck: refactor against present pressure, not imagined futures. Defer to second concrete consumer.
