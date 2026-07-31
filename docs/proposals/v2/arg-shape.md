# Argument shape — one kind vocabulary for controls

**Status: WORKSHOP DRAFT** — 2026-07-30, Ryan + Fable. Contract not yet
landed; the ⁇ marks are the open questions. Companion defect work (the
elicit sugar projecting shapeless schemas) is in flight and independent
of this contract.

## The problem

A prompt argument can declare a `schema` (`PromptArgument.schema:
StandardSchemaV1`, spec `prompts-harness.ts:55`) — but Standard Schema
is validate-only by design and a validation function cannot cross the
wire. So the client record carries `name` / `description` / `required` /
`completeRef` / `completeRequires` and **no type information**: every
argument renders as a bare text input, whether it is an enum of five
markup percentages, a number, or a date.

Meanwhile the elicitation surface already speaks a complete, closed kind
vocabulary on its wire — the flat JSON Schema the `Elicit` sugar
constructs:

| Kind              | Flat schema                                                                                                      | Control                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| text              | `type: "string"` + `format` (email · uri · date · date-time) + `pattern` / `minLength` / `maxLength` / `default` | text / email / url / date / datetime input |
| select            | `type: "string"`, `enum`, `enumNames` (from `labels`)                                                            | select                                     |
| multiSelect       | `type: "array"`, `items: {enum, enumNames}`, `uniqueItems`, `minItems` / `maxItems`                              | checkbox group                             |
| number            | `type: "number" \| "integer"`, `minimum` / `maximum` / `default`                                                 | number input                               |
| confirm / boolean | `type: "boolean"`, `default`                                                                                     | checkbox (no wire distinction)             |
| url mode          | no schema — `mode: "url"`, `message`, `url`                                                                      | consent card, not a form                   |

Three client surfaces want to render the same fact about the same
argument: the composer's slot control, the pending-dock's form field,
and the elicitation ask card. The third already has the vocabulary; the
first two have nothing.

## Why existing facts don't suffice (the null hypothesis)

1. **`PromptArgument.schema` cannot serve as-is** — validate-only
   contract, no introspection in the standard, functions don't
   serialize. It stays (it is the invoke-time validator); it just can't
   travel.
2. **`completeRef` cannot say "closed set."** `completeFromList([...])`
   projects the same opaque ref as an open completer — the client
   cannot distinguish select from typeahead.
3. **The elicitation vocabulary exists but only on the elicitation
   wire.** Prompt records never carry it.

## The contract (least new surface)

One optional, wire-safe field on the record:

```ts
// spec/protocol/prompts-harness.ts
export type PromptArgumentRecord = Omit<PromptArgument, "complete"> & {
  readonly complete?: never;
  readonly completeRef?: string;
  readonly completeRequires?: readonly string[];
  /** Flat JSON-Schema property describing the argument's VALUE —
   *  the same vocabulary elicitation forms use. Derived at
   *  registration from `schema` when a projection exists; absent
   *  otherwise (client renders a plain text input). */
  readonly shape?: Readonly<Record<string, unknown>>; // ⁇ name
};
```

- **Derived, never declared twice.** At registration, `shape =
toJsonSchema(arg.schema)` — the existing spec resolution chain (raw
  `jsonSchema()` marker → vendor converter registry → method probe).
  Zod 4 arrives via one `registerJsonSchemaConverter("zod", z.toJSONSchema)`
  at app boot. The degenerate `{type:"object"}` fallback is treated as
  "no shape" and omitted — silence, not a lying field.
- **Same vocabulary, single construction site.** The flat property
  builders (`textProp` … `multiEnumProp`) become the shared,
  exported vocabulary (in-flight: lifted out of the MCP projection).
  `shape` is constrained to that subset — a flat property, never a
  nested object.
- **Wire ride-along is free.** Records already project through
  `prompts/list` / `prompts/get`; a serializable field travels with
  them. The MCP prompts wire has no argument-type field, so `shape`
  does NOT project there — MCP clients degrade to text, agentick
  clients get typed controls. Wire constraints live at the wire.

### Control selection (client-side, non-normative default)

A total function over `(shape, completeRef)`: enum → select (no wire
call); `completeRef` → typeahead over `completions/complete`; number /
integer → number input; `format: date` → datepicker; both present
compose (typed input + suggestions); neither → text input.

### What reduces

`completeFromList(["10","15",…])` becomes `schema: z.enum([...])` — the
select falls out of the shape and the completer can be derived from the
enum. One declaration where today there are two restating each other.

## ⁇ Open questions

- **Field name:** `shape` (avoids colliding with the live `schema`
  field) vs `valueSchema` vs projecting into a `schema`-shadowing
  record field. Current draft: `shape`.
- **Closed-set enforcement:** does an enum shape _reject_ free text in
  the composer, or accept-with-warning? (GRAMMAR §1b's question —
  per-surface decision, deliberately not part of this contract.)
- **Auto-derive a completer from an enum shape?** Tempting reduction
  (enum → both select and completion source) — but a select needs no
  completion round-trip at all, so possibly nothing to derive. Decide
  when a real closed-set arg wants typeahead UX.
- **Skills/commands args:** same projection applies wherever an
  argument record with `schema` exists. Prompts first; extend on the
  three-consumers rule.

## Verification posture

When the contract lands: registration-time derivation pinned per kind
(zod enum → enum shape, zod number bounds → minimum/maximum), absence
pinned (no schema → no shape; unconvertible vendor → no shape, no
degenerate object), and one wire test asserting `prompts/list` carries
`shape` through to the client record.
