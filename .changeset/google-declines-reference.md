---
"@agentick/spec": minor
"@agentick/model-google": patch
---

The Google adapter declines a `reference` media source instead of guessing, and
`FileReferenceSource` finally says whose namespace `fileId` is in.

`MediaSource` includes `FileReferenceSource` — `{ type: "reference", fileId }` — and the
contract was silent about ownership. So the Google adapter read it as a Gemini Files API
id and emitted `fileData: { fileUri: source.fileId }`. Vertex answered:

    Unable to submit request because the fileUri parameter must be a Cloud Storage or
    HTTP(S) URI but the entered value was '019faa2c-5506-7000-b8ea-3c63628e4c89'

Both readings were reasonable; the contract never said. And the consequence was far worse
than one dropped image, because of two facts that compound:

- the rejection is DETERMINISTIC (the URI form is invalid, not the auth), and
- the timeline entry is DURABLE, and every turn resends the whole conversation.

So one attachment made a thread permanently unusable. A later message of "hi" — plain
text, no media — failed on a `fileUri` from three messages earlier, and would keep
failing forever. Retry could not help: the failure was not attributable to the message
being retried.

Two changes, both squarely the framework's own:

**`FileReferenceSource` documents the contract.** `fileId` is in the ADOPTER's namespace,
the framework cannot project it, and an app that uses the type resolves it to a
projectable source (`gcs` / `s3` / `url` / `base64`) before the request leaves — via the
`onModelGenerate` / `onModelGenerateStream` full-middleware keys. `fileName`, `size` and
`mimeType` remain display fields a renderer may rely on without resolving anything.

**The adapter returns `null` for a `reference`.** Gemini's `fileUri` accepts only a
`gs://` URI or one of its own Files API URIs, so no adopter id could ever be valid there.
Emitting a request you know the provider will reject is worse than emitting nothing:
dropping the block costs the model one image, whereas guessing cost the user their
conversation. Every call site already reads `if (partOut) parts.push(partOut)`, so the
decline is a clean skip.

Because resolution is a PROJECTION and the entry is never rewritten, this repairs threads
that have already failed — retroactively, on their next turn, with no migration and no
compensating log entry.
