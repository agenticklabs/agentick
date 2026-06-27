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
  resolveFormatter,
  sectionEntry,
  stateChangeBlock,
  systemEventBlock,
  userActionBlock,
  videoBlock,
  xmlBlock,
  type WalkScope,
} from "@agentick/compiler-next";
import type {
  AudioMimeType,
  ContentBlock,
  ContextEntry,
  DocumentMimeType,
  FormatDiagnostic,
  ImageMimeType,
  MediaSource,
  MessageEntry,
  VideoMimeType,
} from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

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
 *
 * `scope` carries the active `<format>` binding so section / message
 * dispatch can stamp `renderedWith` on the produced entries.
 */
export function dispatchBlock(
  tag: string,
  props: Readonly<Record<string, unknown>>,
  inner: WalkResult,
  scope: WalkScope,
): WalkResult {
  switch (tag) {
    case "section":
      return sectionCase(props, inner, scope);
    case "message":
    case "system":
    case "user":
    case "assistant":
      // NOTE: `<tool>` was previously in this fall-through (role
      // shorthand for `role="tool"`) but every callsite uses it as a
      // declaration (with `name` + `inputSchema` props). Step 3b
      // moved `<tool>` to `dispatch-declarations.ts`; for tool-result
      // messages, use `<message role="tool">` explicitly.
      return messageCase(tag, props, inner, scope);

    case "code":
      return blocksWith(inner, codeBlock(innerText(inner.blocks), asString(props.language)));
    case "json":
      return blocksWith(inner, jsonBlock(props.data));
    case "xml-block":
      return blocksWith(inner, xmlBlock(innerText(inner.blocks)));
    case "html-block":
      return blocksWith(inner, htmlBlock(innerText(inner.blocks)));
    case "csv-block":
      return blocksWith(inner, csvBlock(innerText(inner.blocks), asStringArray(props.headers)));
    case "reasoning":
      return reasoningCase(props, inner);

    case "image":
      return mediaCase("image", props, inner, (src, mime) =>
        imageBlock({
          source: src,
          ...omitUndefined({
            mimeType: mime as ImageMimeType | undefined,
            altText: asString(props.altText),
            id: asString(props.id),
          }),
        }),
      );
    case "audio":
      return mediaCase("audio", props, inner, (src, mime) =>
        audioBlock({
          source: src,
          ...omitUndefined({
            mimeType: mime as AudioMimeType | undefined,
            transcript: asString(props.transcript),
            id: asString(props.id),
          }),
        }),
      );
    case "video":
      return mediaCase("video", props, inner, (src, mime) =>
        videoBlock({
          source: src,
          ...omitUndefined({
            mimeType: mime as VideoMimeType | undefined,
            transcript: asString(props.transcript),
            id: asString(props.id),
          }),
        }),
      );
    case "document":
      return mediaCase("document", props, inner, (src, mime) =>
        documentBlock({
          source: src,
          ...omitUndefined({
            mimeType: mime as DocumentMimeType | undefined,
            title: asString(props.title),
            id: asString(props.id),
          }),
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
      // Inert passthrough wrapper — preserve inner exactly.
      return inner;

    default:
      throw new Error(
        `compiler-react: unknown host element <${tag}>. Add a handler in the dispatch, ` +
          `or wrap in a function component that returns a supported intrinsic.`,
      );
  }
}

// ────────── Per-case handlers ──────────

function sectionCase(
  props: Readonly<Record<string, unknown>>,
  inner: WalkResult,
  scope: WalkScope,
): WalkResult {
  return withInner(inner, {
    entries: [
      sectionEntry(
        {
          id: asString(props.id) ?? "anonymous",
          ...omitUndefined({
            title: asString(props.title),
            audience: asAudience(props.audience),
            priority: asNumber(props.priority),
            renderedWith: resolveFormatter(scope, "section"),
          }),
        },
        inner.blocks,
      ),
      ...inner.entries,
    ],
    blocks: [],
  });
}

function messageCase(
  tag: string,
  props: Readonly<Record<string, unknown>>,
  inner: WalkResult,
  scope: WalkScope,
): WalkResult {
  const role: MessageEntry["role"] = (
    tag === "message" ? (asString(props.role) ?? "user") : tag
  ) as MessageEntry["role"];
  return withInner(inner, {
    entries: [
      messageEntry(
        {
          role,
          ...omitUndefined({
            id: asString(props.id),
            renderedWith: resolveFormatter(scope, "message"),
          }),
        },
        inner.blocks,
      ),
      ...inner.entries,
    ],
    blocks: [],
  });
}

function reasoningCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  return blocksWith(
    inner,
    reasoningBlock({
      text: innerText(inner.blocks),
      ...omitUndefined({
        signature: asString(props.signature),
        isRedacted: asBoolean(props.isRedacted),
        id: asString(props.id),
      }),
    }),
  );
}

function mediaCase(
  tag: "image" | "audio" | "video" | "document",
  props: Readonly<Record<string, unknown>>,
  inner: WalkResult,
  build: (source: MediaSource, mime: string | undefined) => ContentBlock,
): WalkResult {
  const source = asMediaSource(props.source);
  if (!source) {
    return appendDiagnostic(droppedBlock(inner), {
      severity: "warning",
      code: "media-missing-source",
      message: `<${tag}> dropped — missing or malformed \`source\` prop.`,
    });
  }
  return blocksWith(inner, build(source, asString(props.mimeType)));
}

function userActionCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  const action = asString(props.action);
  if (!action) {
    return appendDiagnostic(droppedBlock(inner), {
      severity: "warning",
      code: "user-action-missing-action",
      message: "<user_action> dropped — missing `action` prop.",
    });
  }
  return blocksWith(
    inner,
    userActionBlock({
      action,
      ...omitUndefined({
        actor: asString(props.actor),
        target: asString(props.target),
        details: asRecord(props.details),
        text: asString(props.text),
        id: asString(props.id),
      }),
    }),
  );
}

function systemEventCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  const event = asString(props.event);
  if (!event) {
    return appendDiagnostic(droppedBlock(inner), {
      severity: "warning",
      code: "system-event-missing-event",
      message: "<system_event> dropped — missing `event` prop.",
    });
  }
  return blocksWith(
    inner,
    systemEventBlock({
      event,
      ...omitUndefined({
        source: asString(props.source),
        data: asRecord(props.data),
        text: asString(props.text),
        id: asString(props.id),
      }),
    }),
  );
}

function stateChangeCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  const entity = asString(props.entity);
  if (!entity) {
    return appendDiagnostic(droppedBlock(inner), {
      severity: "warning",
      code: "state-change-missing-entity",
      message: "<state_change> dropped — missing `entity` prop.",
    });
  }
  return blocksWith(
    inner,
    stateChangeBlock({
      entity,
      from: props.from,
      to: props.to,
      ...omitUndefined({
        field: asString(props.field),
        trigger: asString(props.trigger),
        text: asString(props.text),
        id: asString(props.id),
      }),
    }),
  );
}

function customCase(props: Readonly<Record<string, unknown>>, inner: WalkResult): WalkResult {
  const tag = asString(props.tag);
  const content = asString(props.content);
  if (!tag || !content) {
    return appendDiagnostic(droppedBlock(inner), {
      severity: "warning",
      code: "custom-block-missing-fields",
      message: "<custom> dropped — `tag` and `content` props are both required.",
    });
  }
  return blocksWith(
    inner,
    customBlock({
      tag,
      content,
      ...omitUndefined({
        attrs: asStringRecord(props.attrs),
        selfClosing: asBoolean(props.selfClosing),
        id: asString(props.id),
      }),
    }),
  );
}

// ────────── Tiny helpers ──────────

/**
 * Build a result that emits `block` while preserving inner's
 * entries / diagnostics / specConfig / providerOptions.
 */
function blocksWith(inner: WalkResult, block: ContentBlock): WalkResult {
  return withInner(inner, { entries: inner.entries, blocks: [block] });
}

/**
 * Build a result that drops the block (entry-only) while preserving
 * inner's entries / diagnostics / specConfig / providerOptions.
 */
function droppedBlock(inner: WalkResult): WalkResult {
  return withInner(inner, { entries: inner.entries, blocks: [] });
}

/**
 * Forward inner's optional fields (diagnostics, specConfig,
 * providerOptions, declaration arrays) onto `out`. Caller supplies
 * the new entries/blocks.
 *
 * Declaration arrays MUST forward even when the parent intrinsic
 * (section / message / etc.) doesn't itself produce a declaration —
 * a `<tool>` nested inside a `<section>` is still a top-level tool
 * declaration on the RenderedTree.
 */
function withInner(
  inner: WalkResult,
  out: { entries: readonly ContextEntry[]; blocks: readonly ContentBlock[] },
): WalkResult {
  const result: {
    entries: readonly ContextEntry[];
    blocks: readonly ContentBlock[];
    diagnostics?: readonly FormatDiagnostic[];
    specConfig?: WalkResult["specConfig"];
    providerOptions?: WalkResult["providerOptions"];
    tools?: WalkResult["tools"];
    mcps?: WalkResult["mcps"];
    resources?: WalkResult["resources"];
    outputs?: WalkResult["outputs"];
  } = { entries: out.entries, blocks: out.blocks };
  if (inner.diagnostics?.length) result.diagnostics = inner.diagnostics;
  if (inner.specConfig) result.specConfig = inner.specConfig;
  if (inner.providerOptions) result.providerOptions = inner.providerOptions;
  if (inner.tools?.length) result.tools = inner.tools;
  if (inner.mcps?.length) result.mcps = inner.mcps;
  if (inner.resources?.length) result.resources = inner.resources;
  if (inner.outputs?.length) result.outputs = inner.outputs;
  return result;
}

function appendDiagnostic(result: WalkResult, diag: FormatDiagnostic): WalkResult {
  return {
    ...result,
    diagnostics: [...(result.diagnostics ?? []), diag],
  };
}

function innerText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
