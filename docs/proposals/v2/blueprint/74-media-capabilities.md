# ADR 74 — Media capabilities + capability-aware normalization (#17)

**Status:** DRAFT 2026-07-09 (Fable, for Ryan — design-first; #17 had no prior spec). **Builds on:**
ADR 57 (executor-input currency — the modality wire variants `document`/`audio`/`video`/`reasoning`,
but NO capability-gating), the content-block mime unions (`ImageMimeType`/`DocumentMimeType`/
`AudioMimeType`/`VideoMimeType`) + `MediaSource` forms (`url`/`base64`/`reference`/`s3`/`gcs`),
`TargetCapabilities` (today: a coarse `supportsVision` boolean only). **Fixes:** media sent to a
provider that can't accept it — wrong mime, wrong source form, or an unsupported modality — silently
fails at the provider or gets ad-hoc-mangled, because nothing gates or normalizes against the
target's real media support.

## The problem, precisely

Three independent axes decide whether a media block is deliverable to a given provider, and today
we model NONE of them (only `supportsVision: boolean`):

1. **Modality** — image / audio / video / document. `supportsVision` ≈ "images, maybe"; there is no
   audio/video/document capability at all.
2. **Mime type** — a provider that takes images may accept `png`/`jpeg` but not `gif`; a document
   provider may take `application/pdf` but not `text/markdown`.
3. **Source form** — some providers require inline `base64`; others require a `url`; `s3`/`gcs`
   references almost never go on the wire as-is. The block's `MediaSource` form must match.

Plus size limits, and — the real decision — **what to do when a block ISN'T deliverable**.

## Decision (draft)

### 1. Fine-grained media capability on `TargetCapabilities`
```ts
interface TargetCapabilities {
  // …existing…
  readonly media?: {
    readonly image?: MediaCapability;
    readonly audio?: MediaCapability;
    readonly video?: MediaCapability;
    readonly document?: MediaCapability;
  };
}
interface MediaCapability {
  readonly mimeTypes?: readonly string[];        // supported; omitted = "all/unknown" (permissive)
  readonly sources?: readonly MediaSourceType[]; // url | base64 | reference | s3 | gcs
  readonly maxBytes?: number;
}
```
Each **adapter declares** its `media` capability (openai: `image` png/jpeg/gif/webp via url+base64;
anthropic: `image` + `document` pdf; google: image/audio/video; …). `supportsVision` becomes a
derived alias of `media.image` present (migrate call sites; no back-compat shim).

### 2. A capability-aware normalization pass (in the model layer, BEFORE Stage-1 projection)
A pure pass over the canonical content, reading `target.capabilities.media`, applied per media
block just before ADR 57's `messagePartFromBlock`. Three actions, in order of preference:

- **Source-form transcode (doable, in-core).** Block's modality+mime supported but its SOURCE form
  isn't (e.g. provider needs `base64`, block is `s3`/`url`) → **fetch + re-encode** to a supported
  form. This is the common, high-value normalization (inline-vs-url mismatch) and needs only a
  fetcher + base64 encode — no media codec. Credentials for `s3`/`gcs` stay server-side (a
  resolver, never on the wire — [[credentials_never_cross_wire]]).
- **Mime/format transcode (pluggable, out-of-core).** Mime unsupported but convertible (pdf →
  extracted text, `image/heic` → `png`) → an **adopter-pluggable `MediaTranscoder`** registry. The
  core ships none (codecs are heavy + domain-specific); adopters register per (from-mime → to-mime).
- **Unsupported → the fallback policy.** No transcode path → apply `onUnsupportedMedia`:
  `"placeholder"` (default) replaces the block with a text note (`[image omitted: unsupported by
  <provider>]`) so the model knows content existed; `"drop"` removes it silently; `"error"` throws
  a typed `UnsupportedMediaError`. Configurable per app / per target.

### 3. Where it lives
The pass is a stage in `@agentick/model`'s projection pipeline (the ADR-57 Stage-1 home),
consuming `target.capabilities.media`. Adapters keep projecting the (now-normalized) blocks; they
stop having to defensively down-convert. A `runMediaNormalization(content, capabilities, opts)`
export + conformance suite (each provider × each modality/source/policy).

## Rejected (draft)
- **Keep `supportsVision: boolean`.** Too coarse — can't express mime/source/audio/video/document.
  Structured `media` subsumes it.
- **Normalize inside each adapter.** Four copies of the same policy, drift-prone. One shared pass;
  adapters declare capability + consume normalized blocks.
- **Ship media transcoders in core.** Codecs are heavy + domain-specific (pdf-extract, image
  transcode). Core owns source-form transcode + the policy; format transcode is a pluggable seam.
- **Silent drop as the default.** The model should know content was there → `placeholder` default;
  `drop`/`error` are opt-in.

## Open (workshop before build)
1. **Default policy** — `placeholder` vs `error`. (Lean: `placeholder` — safe, informative; a
   strict adopter opts into `error`.)
2. **`supportsVision` migration** — derive-and-keep as an alias, or remove and update all readers?
   (Lean: remove; one capability model.)
3. **Source-fetch + credentials** — the `s3`/`gcs`/`url` fetcher: a resolver seam on the app; how it
   gets credentials (server-side, never wire). Reuse any existing resource/credential resolver?
4. **`MediaTranscoder` interface** — `(block, fromMime, toMime) => block | undefined`; a registry
   keyed by (modality, from→to); async; where registered (app config per ADR 71?).
5. **Size limits** — `maxBytes` enforcement: error vs down-sample (down-sample needs a codec →
   pluggable).
6. **Always-on vs opt-in** — is the pass always applied (permissive when `media` is undefined =
   "unknown, pass through") or opt-in? (Lean: always-on, permissive-by-default so undeclared
   capabilities don't break existing flows.)
7. **Reasoning blocks** — ADR 57 treats `reasoning` as a modality; is it capability-gated too
   (some providers reject foreign signed thinking) or handled separately (it already round-trips
   per ADR 57)?

@see ADR 57 (the currency this gates) + `agentick.config.ts` (ADR 71 — a natural home for
`onUnsupportedMedia` + the transcoder registry).
