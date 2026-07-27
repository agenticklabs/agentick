/**
 * PascalCase wrappers for the content-block intrinsics whose lowercase names
 * collide with React's HTML/SVG elements and therefore cannot be declared in
 * the JSX namespace (`text` is SVG; `code`, `image`, `audio`, `video` are
 * HTML — see the omission notes in `../jsx-intrinsics.ts`).
 *
 * Each is sugar for `React.createElement("<intrinsic>", props)` — byte-
 * identical IR to the intrinsic, pinned by test. Props are the contributor's
 * own prop types from `@agentick/compiler`, so a spec change to a block shape
 * flows through with no local drift.
 *
 * The non-colliding blocks stay lowercase intrinsics (`<json>`, `<document>`,
 * `<csv>`, …) — no wrapper is minted where none is forced.
 */

import * as React from "react";
import type {
  AudioProps,
  CodeProps,
  ImageProps,
  TextBlockProps,
  VideoProps,
} from "@agentick/compiler";

/** `<Text text="…"/>` or `<Text>…</Text>` — a plain text block. */
export function Text(props: TextBlockProps & { readonly children?: React.ReactNode }) {
  return React.createElement("text", props);
}

/** `<Code language="ts" text="…"/>` — a fenced code block. `language` is required. */
export function Code(props: CodeProps & { readonly children?: React.ReactNode }) {
  return React.createElement("code", props);
}

/** `<Image source={…}/>` — an image block. */
export function Image(props: ImageProps) {
  return React.createElement("image", props);
}

/** `<Audio source={…}/>` — an audio block. */
export function Audio(props: AudioProps) {
  return React.createElement("audio", props);
}

/** `<Video source={…}/>` — a video block. */
export function Video(props: VideoProps) {
  return React.createElement("video", props);
}
