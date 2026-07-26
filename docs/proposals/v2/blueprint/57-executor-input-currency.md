# ADR 57 — The executor-input currency: lossless modalities + consistent provider-knob naming

**Status:** PROPOSED 2026-07-06 (Fable, for Ryan — scope + placement + naming ratified same day)
**Depends on:** ADR 52 (the ONE LanguageModelExecutor + LanguageModelAdapter), the content-block union
**Fixes:** the content-block projection cut-blockers (CB-BLOCKER-1/2 in CUT-GAP-AUDIT.md), #176 (providerOptions orphan)
**Adjacent:** #173 (message-level providerMetadata), #174 (custom-block formatter — NOT this ADR), #185 (CacheHint)

## TL;DR

`LanguageModelInput` — the currency every adapter consumes — is **lossy and
inconsistently named**, and it silently drops IR data three ways:

1. **Modalities annihilated.** `LanguageModelMessagePart` has exactly four variants
   (`text`/`image`/`tool_use`/`tool_result`). Stage-1 projection
   (`model/src/canonical-projection.ts:136` `messagePartFromBlock`) folds the 22-member
   `ContentBlock` union onto it, and its `default` emits
   `text: "text" in block ? block.text : JSON.stringify(block)` — so a `document`,
   `audio`, `video`, or `reasoning` block is annihilated _before any adapter runs_.
   All four adapters starve uniformly. This is v1's document-block bug reintroduced
   **structurally** (verified in code 2026-07-06).
2. **providerOptions orphaned.** The reconciler collects `<ProviderOptions>` into
   `RenderedTree.providerOptions`, but nothing threads it into `LanguageModelInput` —
   adapters read only `target.providerOptions`. Every tree-declared provider knob
   (thinking config, seed, safetySettings, cache_control) is dropped (#176).
3. **Provider-knob field misnamed.** Parts carry `providerMetadata?: ProviderMetadataBag`
   for the _input_ direction, but `target`/`RenderedTree` use `providerOptions`, and the
   semantically-correct split (ai-sdk's, and the industry norm) is **`providerOptions` =
   what you send · `providerMetadata` = what the provider returns**.

One currency pass fixes all three. The unifying principle for what belongs on the wire
currency vs. what doesn't is in §Taxonomy.

## Taxonomy — what is a wire part vs. what the formatter owns

**The line:** _does the provider have a native structural representation that text cannot
substitute for?_

- **Wire-native modalities → get a `LanguageModelMessagePart` variant.** `document`
  (base64/url/file PDF), `audio` (OpenAI `input_audio` / Gemini audio), `video` (Gemini),
  `reasoning` (signed thinking — must round-trip verbatim). `generated_image` /
  `generated_file` reuse the `image`/`document` variants when replayed as input.
- **Textual blocks → the formatter flattens to text; NO wire variant.** `json`, `xml`,
  `csv`, `html`, `code`, `custom`, and the event blocks (`user_action`/`system_event`/
  `state_change`). The text formatter (`formatters/src/text.ts`) already owns
  json/xml/csv/html/code/events **by design** — they're serializations the model reads as
  text. **`custom` is in this bucket** (`.tag` + `.content` → tag-wrapped text): it does
  NOT get a wire variant. Its bug is that the formatter has no `custom` case, so it falls
  through to Stage-1's `JSON.stringify` default — that is **#174** (customBlocks
  self-documentation: declared tags inject their protocol into the system prompt), not
  this ADR.
- **Provider-specific / minor, deferred:** `executable_code` / `code_execution_result`
  are a Gemini-native feature — MINOR, provider-specific, deferred (own follow-up).
  `task_ref` stays canonical `{_kind}` JSON; the Anthropic override just needs the same
  case the base mapper has (fold in — trivial).

## Design

### 1. `LanguageModelMessagePart` — add modality variants (`spec/src/protocol/executor.ts:227`)

Add four variants, mirroring the canonical block shapes (`MediaSource` for media,
`signature`/`data` for reasoning):

```ts
| { readonly type: "document"; readonly source: MediaSource; readonly mediaType?: string;
    readonly providerOptions?: ProviderOptions; readonly providerMetadata?: ProviderMetadataBag }
| { readonly type: "audio";    readonly source: MediaSource; readonly mediaType?: string; … }
| { readonly type: "video";    readonly source: MediaSource; readonly mediaType?: string; … }
| { readonly type: "reasoning"; readonly text: string; readonly signature?: string;
    readonly data?: unknown; /* redacted opaque */ … }
```

Reuse the canonical `MediaSource` (`content-blocks.ts` — url/base64/reference/s3/gcs) so
adapters project it to their wire form (base64 / url / file-id) without lossy
pre-flattening. (The existing `image` part pre-flattens to `imageUrl: string`; align the
new parts on `MediaSource` and note the image part as a candidate follow-up — do not
churn it here.)

### 2. Rename the per-part provider-knob field (input) + reserve `providerMetadata` (output)

On EVERY `LanguageModelMessagePart` variant: the **input** provider-knob field is
`providerOptions?: ProviderOptions` (typed, augmentable — same type target/tree use). Keep
`providerMetadata?: ProviderMetadataBag` for the **output** direction — what `normalize`
writes from a provider response (returned cache/reasoning tokens, `thoughtSignature` as
returned). Input parts set `providerOptions`; normalized output parts set
`providerMetadata`. This is the ai-sdk split and matches `target`/`RenderedTree`.

### 3. `LanguageModelInput.providerOptions` — the request-level channel (fixes #176)

Add `readonly providerOptions?: ProviderOptions;` to `LanguageModelInput`, sibling to
`parameters` — mirroring `RenderedTree`'s `config` + `providerOptions` siblings. `project()`
folds `tree.providerOptions` **over** `target.providerOptions` (tree/per-render wins; reuse
the `mergeProviderOptions` helper, #176) onto `input.providerOptions`. Adapters read it.
Keep `LanguageModelParameters` as pure canonical generation knobs — providerOptions is a
separate dimension.

### 4. Projection — the two Stage-1 mappers + the four adapters

- `canonical-projection.ts:messagePartFromBlock`: add `document`/`audio`/`video`/`reasoning`
  cases (carry `source`/`signature`); carry per-block `providerOptions`. The `default`
  (JSON.stringify) stays only for genuinely-unknown blocks — after this, no first-class
  modality hits it.
- `model-anthropic/src/anthropic-adapter.ts:918` override mapper: same cases + the
  `task_ref` case it currently lacks.
- Each adapter's `buildParams`/input switch (`model-openai`, `model-google`,
  `model-anthropic`, `model-ai-sdk`): consume the new variants → native provider parts,
  porting v1's proven shapes (v1 refs: anthropic `packages/adapters/anthropic/src/anthropic.ts:537`,
  openai `openai.ts:565`, google `google.ts:454`). Read `part.providerOptions` +
  `input.providerOptions`.

### 5. Output direction — Anthropic thinking round-trip (CB-BLOCKER-1, in scope)

`normalize` must capture what it currently discards: Anthropic `thinking` → a `reasoning`
part carrying `signature` (currently dropped, :1057-1062); `redacted_thinking` → carry the
opaque `data` (currently `void (block)`, :1068). This closes the extended-thinking +
tool-use round-trip (Anthropic requires the signed block replayed verbatim next turn).
ai-sdk reasoning-output mapping and Google response `inlineData`/`executableCode` are
**major but deferred** to a follow-up (per-adapter `normalize`, not currency) unless cheap
to include.

## Scope

**In:** the four modality variants + the `providerOptions`/`providerMetadata` input/output
split on the part + `LanguageModelInput.providerOptions` (#176) + both Stage-1 mappers +
the four adapters' input projection + Anthropic thinking `signature`/`data` round-trip +
conformance cells (each adapter × each new modality; providerOptions round-trip; Anthropic
thinking replay). **Out:** `custom` (→ #174 formatter), `executable_code`/
`code_execution_result` (Gemini-native, follow-up), ai-sdk/Google _output_ multimodal
drops (follow-up), the `image`-part MediaSource realignment (follow-up).

## Rejected

- **Per-adapter document patches.** Treats the symptom. The starvation is the boundary
  type; one currency change re-enables native projection in all four adapters at once.
- **A wire variant for `custom` (or json/xml/csv).** They're textual — the formatter's
  job. A provider has no native "custom" part. Widening the wire currency for them
  confuses the layer.
- **providerOptions on `LanguageModelParameters`.** Conflates canonical generation knobs
  with the provider escape hatch. It's a sibling dimension → `LanguageModelInput`.
- **Keeping `providerMetadata` for input.** It reads as "what the provider returned";
  input knobs are `providerOptions` everywhere else. Consistency + the industry split win.

## Tests

Conformance suite gains: (a) each adapter projects each new modality to its native wire
part (document/audio/video), with a v1-parity assertion for `document`; (b) a tree-declared
`providerOptions` reaches `buildParams` output (the #176 regression gate); (c) an Anthropic
`thinking` block round-trips its `signature` through normalize → re-projection. The
`generated_image` token-bomb (base64 into text) gets an explicit assertion it no longer
happens.
