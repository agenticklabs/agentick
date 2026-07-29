---
"@agentick/spec": major
"@agentick/model": major
"@agentick/model-executor": minor
"@agentick/model-google": major
"@agentick/model-openai": major
"@agentick/model-anthropic": major
"@agentick/model-ai-sdk": major
"@agentick/session": minor
"@agentick/timeline": minor
"@agentick/spec-conformance": minor
---

**BREAKING.** Media inputs survive the trip to a provider, or you are told why they did not.

## The bug

An `image` part carried `imageUrl: string` while `document` / `audio` / `video` carried a
`MediaSource`. So a source with no lexical form was destroyed before any adapter saw it: an
adopter's `{ type: "reference", fileId }` became the bare id, and Vertex answered

    Unable to submit request because the fileUri parameter must be a Cloud Storage or
    HTTP(S) URI but the entered value was '019faa2c-5506-7000-b8ea-3c63628e4c89'

A deterministic rejection against a durable timeline entry — and since every turn replays
the whole conversation, one attachment made a thread **permanently unusable**. No adapter
fix could have helped; the information was gone upstream of all of them.

## What changed

**`image` carries a `MediaSource`**, like its three siblings. Four functions that existed
only to flatten and re-parse it are deleted, not fixed — `imageUrlFromSource` had no honest
`reference` arm, because a `string` return cannot express "I cannot represent this".

**`MediaSource` is three closed kinds** — `base64` | `url` | `reference`. `s3` and `gcs` are
deleted: the framework only ever re-concatenated their fields into a URI, so an app
decomposed a URI purely so we could reassemble it, and the set had no closure (R2, Azure,
MinIO, IPFS, `file:` were all equally entitled). A `url` takes **any scheme**.

**Targets declare what they can carry**, per modality, and the framework enforces it
immediately before the adapter builds its request:

```ts
capabilities: {
  media: { image: ["base64", "url"], document: ["base64", "url"] },
  //       ^ audio and video ABSENT — this target carries neither
  urlSchemes: ["https", "http", "data", "gs"], // Vertex reads Cloud Storage natively
}
```

Absent `media` means **undeclared** — nothing is screened, never "carries nothing".
Present means **complete**: a modality with no entry carries nothing. `urlSchemes` defaults
to `["http", "https", "data"]`.

Why a declaration and not adapter discipline: whether a part could go on the wire was
decided four times, once per adapter, inside a `switch` returning `null` — and the verdict
was **discarded**. A part that could not be carried was skipped and the request SUCCEEDED,
so the model never saw the user's attachment and nothing recorded it. Worse, Anthropic has
no `audio` or `video` arm at all, so those parts fall off the end with no `null` for any
reporting convention to observe. Moving the fact onto the target makes it data: enforced in
one place, and **checkable** — `runMediaDeclarationCheck` (`@agentick/model/testing`)
asserts each adapter's declaration against its real wire projection, both directions.

**A declined part is reported.** The executor emits one `ctx.log` warning per decline,
carrying coordinates that join `buildMessageProvenance` to a timeline entry id. Zero new
API; the happy path emits nothing.

## New

|                          |                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildMessageProvenance` | Which timeline entry produced which projected part. Derived, never stored — it is a function of `(tree, target)`, so it is a property of a projection rather than of a message                                                                                |
| `applyMediaSupport`      | The screen, as data: the wire messages plus the declines                                                                                                                                                                                                      |
| `detectDroppedInputs`    | What an adapter silently discarded, by differential projection — no adapter cooperation, no network. Found four drops that were prose `TODO`s: `responseFormat` on anthropic/ai-sdk, replayed reasoning on google/openai. Each is now a characterization test |
| `boundary.target`        | Which target ran a turn. A `succeeded` boundary proves every entry it carried was projectable — but only for that target, so an app narrowing suspects to "entries since the last success" can tell a comparable success from one across a failover           |

## Migrating

```diff
- { type: "image", imageUrl: "https://x/y.png" }
+ { type: "image", source: { type: "url", url: "https://x/y.png" } }

- { type: "gcs", bucket, object }
+ { type: "url", url: `gs://${bucket}/${object}` }
```

A target that fetches a non-HTTP scheme must declare it in `capabilities.media.urlSchemes`,
or the screen declines it — with a stated reason, rather than letting the provider reject it.

A `reference` is the one source the framework **cannot** resolve: `fileId` is in your
namespace. Swap it for a `url` or `base64` source in an `onBeforeModelGenerate` hook — that
seam runs before the screen, precisely so it gets its chance — or accept that it is dropped
and reported.
