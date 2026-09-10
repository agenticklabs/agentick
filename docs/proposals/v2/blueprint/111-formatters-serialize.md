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
   parse; validity across a dialect boundary is the author's call. Serialization
   is therefore **depth-first**: a serializer only ever receives a subtree
   entirely in its own dialect, and composition across dialects is a frame —
   a string around an already-rendered string. No serializer sees a foreign
   node, so none needs a verbatim node.
5. **Text round-trips byte-for-byte.** Pretty-printing lays out elements; it
   never indents, wraps or normalises inside a text node. A user's newlines
   survive.
6. **Parity is reviewed, not assumed.** Before the branch merges, a report of
   every rendered fixture before and after — the actual prompt text — so what
   moved (self-closing tags, whitespace, attribute order) is decided, not
   discovered.

## Design

### The node model, and depth-first composition

```ts
type Node =
  | { kind: "element"; name: string; attrs: Record<string, string>; children: Node[] }
  | { kind: "text"; text: string }; // escaped by the serializer
```

A formatter's own code is one function per block type and one per semantic
element, each returning nodes. That is the whole formatter.

An island never appears as a node. Sections are block-level, so an island is
always a whole section: it is rendered first, by its own dialect, to a string
(`expandSections` already runs body-first-then-frame), and the containing
dialect receives that string at a **frame**. A frame is the one place our
code writes markup — `<message role="user">` + body + `</message>`, or a
section's tag around its rendered body — and it composes strings, not nodes.
Its tag name is one we declared and its attribute comes from a fixed set; no
user content passes through it. Everything inside a frame that is our
dialect's own went through the serializer; everything that is another
dialect's arrived as bytes.

### XML

`xmlFormatter(options?)` builds the node tree and serializes with
`fast-xml-parser`'s `XMLBuilder` in `preserveOrder` mode, passing
`options.builder` through (`format`, `indentBy`, `suppressEmptyNode`, …). Our
layer: `options.blocks`, a partial map from block type to node builder, so an
adopter changes how `tool_use` or `json` renders without replacing the
formatter. `frameMessage` becomes the `message` element with a `role`
attribute — a node like any other. The bare `xmlFormatter` export stays as
`xmlFormatter()`.

**Spike, 2026-09-10** (`scratchpad/spike-xmlbuilder2`, throwaway), on eight
hostile texts — angle brackets, `&&`, quotes, a forged `</message>`, leading
and trailing spaces, tabs, blank-line runs, literal entities — plus a
quoted-and-angled attribute value:

- `xmlbuilder2`: **disqualified.** Its writer deliberately leaves an `&` alone
  when it already looks like an entity (`nonEntityAmpersandRegex`), so a
  user's literal `&lt;x&gt;` reads back as `<x>`. Text is not byte-faithful
  and there is no option.
- `fast-xml-parser` `XMLBuilder`, `preserveOrder: true, format: true`:
  document order kept across interleaved element names, indentation never
  enters a text node, every text and attribute round-trips byte-for-byte
  through its own parser. **Chosen.**
- `@xmldom/xmldom`: spec-faithful serializer, same round-trip, but no
  pretty-printer. The fallback if the builder ever misbehaves.

Escaping is the XML minimum and nothing more, supplied as the builder's two
value processors: text escapes `& < >`, attributes escape `& < "`. Its default
processing is also correct but writes `&apos;` for every apostrophe in user
text. Two one-line functions, and correctness is proven by parse-back, not by
reasoning about text — this is not a rule over arbitrary content, which ADR
110 §4 withdrew.

### Markdown

Same move: build `mdast` nodes and serialize with `mdast-util-to-markdown`,
passing its options through (`bullet`, `emphasis`, `strong`, `fences`,
`listItemIndent`, and its `handlers` / `unsafe` extension points, which are
the library's own per-node override). The `**role:**` frame is a paragraph
with a strong node. Islands compose the same way: rendered first by their own dialect, spliced at
a frame; `unsafe` is where markdown's own escaping is decided.

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
- An island's bytes are identical before and after composition — the
  containing dialect's serializer never saw them.
- Output with no islands parses as XML.
- The parity report: every existing formatter fixture rendered on `feat/v2`
  and on this branch, diffed, committed as the review artifact.

## Sequencing

1. ~~Spike~~ — done, see §XML. Library chosen.
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
