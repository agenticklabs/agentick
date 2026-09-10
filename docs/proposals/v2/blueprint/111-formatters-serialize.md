# ADR 111 — Formatters build a document and let a hardened serializer write it

**Status:** DRAFT 2026-09-10 (Fable, with Ryan). Branch `feat/formatters-serialize`.
**Depends on:** ADR 22 §D2/§D6 (formatter shape, tree-level serialization), ADR 36 (create vs define), ADR 94 (sections lower to content), ADR 110 §4 (escaping is full where the dialect produces text).
**Touches:** `@agentick/formatters` only. The protocol (`createFormatter`, `DefinedFormatter`, `CompilerHarnessOptions.formatters`, `FormatScope`) is kept; the built-ins change underneath it.

## Problem

The XML formatter is 258 lines of string templates. Every element is
concatenated by hand, `escapeXml` is called at fifteen separate sites, and
indentation is a manual join. Correctness rests on nobody forgetting a call,
and the tests can only pin the strings we happened to produce. The markdown
formatter is the same shape with a different vocabulary. The built-ins are
constants: an adopter who wants a different indent, a self-closing policy, or
a different rendering of one block type replaces the whole formatter.

None of this is the framework's job. The framework is responsible for **what
a block or an element means** — which node it becomes. Turning nodes into
bytes, escaping, quoting, pretty-printing, is a solved problem with
maintained implementations, and every line of it we own is a line that can be
wrong in a way only a prompt reveals.

## Requirements

1. **Serialization is not ours.** A formatter builds a document — elements,
   attributes, text nodes — and a well-known serializer writes it. Escaping is
   a property of the node model, never a call site.
2. **Formatters are pure values, configured at construction.** No state
   across renders; no per-use instances (ADR 36: `create`, not `define`).
   Configuration is the serializer's own options passed through, plus one
   layer of ours: a per-block-type override.
3. **Adopters register their own** through `createFormatter` against the
   existing protocol, or configure a built-in, and pick either per scope.
4. **Islands embed verbatim** (`create-formatter.ts`, "Islands embed
   VERBATIM"). A markdown island inside XML keeps its raw `&`; an XML island
   inside markdown keeps its tags. Prompt "XML" is a convention providers never
   parse; validity across a dialect boundary is the author's call. The
   serializer must therefore accept a verbatim node, or the island is spliced
   after serialization by placeholder. Either way the author's bytes are
   untouched.
5. **Text round-trips byte-for-byte.** Pretty-printing lays out elements; it
   never indents, wraps or normalises inside a text node. A user's newlines
   survive.
6. **Parity is reviewed, not assumed.** Before the branch merges, a report of
   every rendered fixture before and after — the actual prompt text — so what
   moved (self-closing tags, whitespace, attribute order) is decided, not
   discovered.

## Design

### The node model

```ts
type Node =
  | { kind: "element"; name: string; attrs: Record<string, string>; children: Node[] }
  | { kind: "text"; text: string } // escaped by the serializer
  | { kind: "verbatim"; text: string }; // an island; never escaped
```

A formatter's own code is one function per block type and one per semantic
element, each returning nodes. That is the whole formatter.

### XML

`xmlFormatter(options?)` builds the node tree and serializes with
`xmlbuilder2`, passing `options.writer` through (`prettyPrint`, `indent`,
`width`, `allowEmptyTags`, …). Our layer: `options.blocks`, a partial map from
block type to node builder, so an adopter changes how `tool_use` or `json`
renders without replacing the formatter. `frameMessage` becomes the `message`
element with a `role` attribute — a node like any other. The bare
`xmlFormatter` export stays as `xmlFormatter()`.

Open until the spike settles it: whether `xmlbuilder2` can carry a verbatim
node. If not, islands serialize by placeholder and splice after; if a second
library does it natively (`fast-xml-parser`'s builder, `@xmldom/xmldom`), the
spike says which. The choice is made by requirements 4 and 5, not by
preference.

### Markdown

Same move: build `mdast` nodes and serialize with `mdast-util-to-markdown`,
passing its options through (`bullet`, `emphasis`, `strong`, `fences`,
`listItemIndent`, and its `handlers` / `unsafe` extension points, which are
the library's own per-node override). The `**role:**` frame is a paragraph
with a strong node. Markdown has no verbatim-node problem: `unsafe` is where
escaping is decided, and an island is a `html` node, which the serializer
writes as-is.

### Registration

`CompilerHarnessOptions.formatters` already takes a map. `formatters([...])`
builds it from a list so an adopter writes
`formatters([xmlFormatter({ writer: { indent: "\t" } }), myYamlFormatter])`
rather than assembling a `Map` by id. Sugar; the map stays the contract.

### What stays exactly as it is

The protocol. `render(blocks) → blocks`, `frameMessage`, `blocksToText`,
`expandSections` running ahead of `render`, `FormatScope` resolution by id and
format, `formatTree` as the single tree-level entry point. An adopter's
existing custom formatter is untouched.

## Tests, written before the port

- Every text node round-trips byte-for-byte through the pretty printer, with
  newlines, leading whitespace, angle brackets, ampersands, quotes.
- No content can open or close an element: `</message>` inside a text block
  is text after serialization; `"` inside an attribute value is text.
- An island's bytes are identical before and after serialization.
- Output with no islands parses as XML.
- The parity report: every existing formatter fixture rendered on `feat/v2`
  and on this branch, diffed, committed as the review artifact.

## Sequencing

1. Spike: one fixture through `xmlbuilder2`, verbatim node or placeholder
   splice, text round-trip. Decides the library. Half a day, throwaway.
2. XML on the node model; the tests above; parity report.
3. Markdown on `mdast`; parity report.
4. Factories with pass-through options; `formatters([...])`.
5. Merge to `feat/v2` on the parity review, one lane.

## Follow-on, not here

- **`<Rendered format=…>`** — a component that formats its subtree to one text
  block at compile time, so an app can render a slice of past messages inside
  a tool result with the current renderer on every tick. Its own ADR; it is
  "build the subtree's nodes, serialize" once this lands.
- **Per-scope options** (`<XML indent={4}>`): extend `render` with a scope
  argument, still no instances.
