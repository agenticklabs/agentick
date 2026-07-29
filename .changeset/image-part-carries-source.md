---
"@agentick/spec": major
"@agentick/model": major
"@agentick/model-google": major
"@agentick/model-openai": major
"@agentick/model-anthropic": major
"@agentick/model-ai-sdk": major
"@agentick/spec-conformance": major
---

**BREAKING.** The canonical `image` message part carries a `MediaSource` instead of a
pre-flattened `imageUrl: string`.

`LanguageModelMessagePart` had four media members. Three carried a `MediaSource`; `image`
carried a string. The docblock on the member immediately below it already said why that
was wrong:

> Wire-native document (PDF etc.). Carries a `MediaSource` so adapters project to their
> wire form (base64 / url / file-id) **without lossy pre-flattening**.

`image` was the one member that still did the lossy pre-flattening that comment warns
against, and it cost two things.

**It destroyed sources with no lexical form.** `imageUrlFromSource` had to return a
`string`, so `{ type: "reference", fileId }` — an adopter's own file id, which the
framework by contract cannot resolve — became the bare id, typed as a URL. Vertex
answered:

    Unable to submit request because the fileUri parameter must be a Cloud Storage or
    HTTP(S) URI but the entered value was '019faa2c-5506-7000-b8ea-3c63628e4c89'

Deterministic rejection against a durable timeline entry. Since every turn replays the
whole conversation, one attachment made a thread permanently unusable — a later message
of plain text failed on a `fileUri` from several messages earlier, forever. And no
adapter fix could have helped: the information was gone before any adapter saw it.

**It forced adapters to re-parse.** The Anthropic adapter carried
`imageSourceFromUrl(imageUrl, mimeType)`, which regex-matched a `data:` URL to recover
the base64 payload the framework had just stringified — a structured value flattened and
then reverse-engineered, losing exactly the cases with no string form.

It survived this long because two of four providers happen to want a URL string on the
wire (OpenAI's `image_url`, the AI SDK's `image`), so the flattening looked free until a
source type appeared that has no string form.

## What changed

- **spec**: the `image` part is `{ type: "image"; source: MediaSource; mediaType? }`,
  aligned with `document` / `audio` / `video`.
- **`imageUrlFromSource` is DELETED**, not fixed. It had no honest `reference` arm — a
  `string` return cannot express "I cannot represent this."
- **google**: the `image` case joins `googlePartFromSource`, the one path the other three
  kinds always used; `imagePartFromUrl` is deleted. A `reference` is declined (`null`)
  rather than emitted as an invalid `fileUri`, and a declined block does not take the
  user's text with it.
- **anthropic**: `imageSourceFromUrl` (the re-parser) and `anthropicImageUrlFromSource`
  are both deleted, replaced by `anthropicImageSource(source, mimeType)` projecting
  directly, declining what Anthropic cannot fetch.
- **openai**: gains `openAIImagePartFromSource`, matching the `…PartFromSource` +
  skip-on-null shape `document` and `audio` already used.
- **ai-sdk**: `image` uses the same `aiSDKFileData` projection as document / audio /
  video. Its `reference` arm still forwards a bare id — that adapter forwards opaque
  strings by contract, so it is marked `TODO(ai-sdk-reference)` rather than silently
  changing three other kinds' behaviour.
- **generated_image** replayed as input now emits a `Base64Source` rather than
  concatenating a `data:` URI — one fewer full-payload string build per projection.

## Migrating

An adapter or consumer reading `part.imageUrl` reads `part.source` and projects it. If it
needs a URL string, build one from `base64` / `url` and decline the rest — do not invent
a form for `reference`, `gcs` or `s3`.

The shared executor conformance suite asserts the source structurally now, including a
case pinning that a `reference` survives projection untouched.
