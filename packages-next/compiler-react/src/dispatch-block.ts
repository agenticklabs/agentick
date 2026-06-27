/**
 * Block-mode dispatch — the default recursion path. Maps host element
 * tags to compiler-next intrinsic helpers and returns the resulting
 * `WalkResult`.
 *
 * Native ContentBlocks (image/audio/code/json/etc.), context entries
 * (section/message/etc.), and event blocks live here. Semantic-html
 * intrinsics (h1-h6, strong, ul/ol/li, …) are routed to
 * `dispatch-semantic.ts` by `walk.ts` BEFORE we reach this switch.
 */

import {
  audioBlock,
  codeBlock,
  csvBlock,
  customBlock,
  documentBlock,
  htmlBlock,
  imageBlock,
  jsonBlock,
  messageEntry,
  reasoningBlock,
  sectionEntry,
  stateChangeBlock,
  systemEventBlock,
  userActionBlock,
  videoBlock,
  xmlBlock,
} from "@agentick/compiler-next";
import type {
  AudioMimeType,
  ContentBlock,
  ContextEntry,
  DocumentMimeType,
  ImageMimeType,
  MediaSource,
  MessageEntry,
  VideoMimeType,
} from "@agentick/spec-next";

import {
  asAudience,
  asBoolean,
  asMediaSource,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  asStringRecord,
} from "./props.js";
import type { WalkResult } from "./walk.js";

/**
 * Dispatch a tag in block-mode. The caller (`walk.ts`) has already
 * walked the children into `inner: WalkResult`. We just combine.
 */
export function dispatchBlock(
  tag: string,
  props: Readonly<Record<string, unknown>>,
  inner: WalkResult,
): WalkResult {
  switch (tag) {
    case "section":
      return sectionCase(props, inner);
    case "message":
    case "system":
    case "user":
    case "assistant":
    case "tool":
      return messageCase(tag, props, inner);

    case "code":
      return blocksWith(
        inner.entries,
        codeBlock(innerText(inner.blocks), asString(props.language)),
      );
    case "json":
      return blocksWith(inner.entries, jsonBlock(props.data));
    case "xml-block":
      return blocksWith(inner.entries, xmlBlock(innerText(inner.blocks)));
    case "html-block":
      return blocksWith(inner.entries, htmlBlock(innerText(inner.blocks)));
    case "csv-block":
      return blocksWith(
        inner.entries,
        csvBlock(innerText(inner.blocks), asStringArray(props.headers)),
      );
    case "reasoning":
      return reasoningCase(props, inner);

    case "image":
      return mediaCase(props, inner, (src, mime) =>
        imageBlock({
          source: src,
          ...(mime !== undefined ? { mimeType: mime as ImageMimeType } : {}),
          ...(asString(props.altText) !== undefined ? { altText: asString(props.altText)! } : {}),
          ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}),
        }),
      );
    case "audio":
      return mediaCase(props, inner, (src, mime) =>
        audioBlock({
          source: src,
          ...(mime !== undefined ? { mimeType: mime as AudioMimeType } : {}),
          ...(asString(props.transcript) !== undefined
            ? { transcript: asString(props.transcript)! }
            : {}),
          ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}),
        }),
      );
    case "video":
      return mediaCase(props, inner, (src, mime) =>
        videoBlock({
          source: src,
          ...(mime !== undefined ? { mimeType: mime as VideoMimeType } : {}),
          ...(asString(props.transcript) !== undefined
            ? { transcript: asString(props.transcript)! }
            : {}),
          ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}),
        }),
      );
    case "document":
      return mediaCase(props, inner, (src, mime) =>
        documentBlock({
          source: src,
          ...(mime !== undefined ? { mimeType: mime as DocumentMimeType } : {}),
          ...(asString(props.title) !== undefined ? { title: asString(props.title)! } : {}),
          ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}),
        }),
      );

    case "user_action":
      return userActionCase(props, inner);
    case "system_event":
      return systemEventCase(props, inner);
    case "state_change":
      return stateChangeCase(props, inner);

    case "custom":
      return customCase(props, inner);

    case "text":
      // Inert passthrough wrapper.
      return inner;

    default:
      throw new Error(
        `compiler-react: unknown host element <${tag}>. Add a handler in the dispatch, ` +
          `or wrap in a function component that returns a supported intrinsic.`,
      );
  }
}

// ────────── Per-case handlers ──────────

function sectionCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  return {
    entries: [
      sectionEntry(
        {
          id: asString(props.id) ?? "anonymous",
          ...(asString(props.title) !== undefined ? { title: asString(props.title)! } : {}),
          ...(asAudience(props.audience) !== undefined
            ? { audience: asAudience(props.audience)! }
            : {}),
          ...(asNumber(props.priority) !== undefined
            ? { priority: asNumber(props.priority)! }
            : {}),
        },
        inner.blocks,
      ),
      ...inner.entries,
    ],
    blocks: [],
  };
}

function messageCase(
  tag: string,
  props: Readonly<Record<string, unknown>>,
  inner: WalkResult,
): WalkResult {
  const role: MessageEntry["role"] = (
    tag === "message" ? (asString(props.role) ?? "user") : tag
  ) as MessageEntry["role"];
  return {
    entries: [
      messageEntry(
        { role, ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}) },
        inner.blocks,
      ),
      ...inner.entries,
    ],
    blocks: [],
  };
}

function reasoningCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  return blocksWith(
    inner.entries,
    reasoningBlock({
      text: innerText(inner.blocks),
      ...(asString(props.signature) !== undefined ? { signature: asString(props.signature)! } : {}),
      ...(asBoolean(props.isRedacted) !== undefined
        ? { isRedacted: asBoolean(props.isRedacted)! }
        : {}),
      ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}),
    }),
  );
}

function mediaCase(
  props: Readonly<Record<string, unknown>>,
  inner: WalkResult,
  build: (source: MediaSource, mime: string | undefined) => ContentBlock,
): WalkResult {
  const source = asMediaSource(props.source);
  if (!source) {
    // Source missing / malformed — drop the media block but preserve
    // any nested entries the user might have placed alongside.
    return { entries: inner.entries, blocks: [] };
  }
  return blocksWith(inner.entries, build(source, asString(props.mimeType)));
}

function userActionCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  const action = asString(props.action);
  if (!action) return { entries: inner.entries, blocks: [] };
  return blocksWith(
    inner.entries,
    userActionBlock({
      action,
      ...(asString(props.actor) !== undefined ? { actor: asString(props.actor)! } : {}),
      ...(asString(props.target) !== undefined ? { target: asString(props.target)! } : {}),
      ...(asRecord(props.details) !== undefined ? { details: asRecord(props.details)! } : {}),
      ...(asString(props.text) !== undefined ? { text: asString(props.text)! } : {}),
      ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}),
    }),
  );
}

function systemEventCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  const event = asString(props.event);
  if (!event) return { entries: inner.entries, blocks: [] };
  return blocksWith(
    inner.entries,
    systemEventBlock({
      event,
      ...(asString(props.source) !== undefined ? { source: asString(props.source)! } : {}),
      ...(asRecord(props.data) !== undefined ? { data: asRecord(props.data)! } : {}),
      ...(asString(props.text) !== undefined ? { text: asString(props.text)! } : {}),
      ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}),
    }),
  );
}

function stateChangeCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  const entity = asString(props.entity);
  if (!entity) return { entries: inner.entries, blocks: [] };
  return blocksWith(
    inner.entries,
    stateChangeBlock({
      entity,
      from: props.from,
      to: props.to,
      ...(asString(props.field) !== undefined ? { field: asString(props.field)! } : {}),
      ...(asString(props.trigger) !== undefined ? { trigger: asString(props.trigger)! } : {}),
      ...(asString(props.text) !== undefined ? { text: asString(props.text)! } : {}),
      ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}),
    }),
  );
}

function customCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  const tag = asString(props.tag);
  const content = asString(props.content);
  if (!tag || !content) return { entries: inner.entries, blocks: [] };
  return blocksWith(
    inner.entries,
    customBlock({
      tag,
      content,
      ...(asStringRecord(props.attrs) !== undefined ? { attrs: asStringRecord(props.attrs)! } : {}),
      ...(asBoolean(props.selfClosing) !== undefined
        ? { selfClosing: asBoolean(props.selfClosing)! }
        : {}),
      ...(asString(props.id) !== undefined ? { id: asString(props.id)! } : {}),
    }),
  );
}

// ────────── Tiny helpers ──────────

function blocksWith(entries: readonly ContextEntry[], block: ContentBlock): WalkResult {
  return { entries, blocks: [block] };
}

function innerText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
