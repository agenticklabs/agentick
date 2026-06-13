/**
 * Tag-routing `DeltaTransform`s used by the base executor.
 *
 * Two flavors, both built on the shared {@link StreamTagParser}:
 *
 *   - **`thinkTagTransform()`** — extracts inline `<think>...</think>` tags
 *     from `content-delta` text and re-routes them to `reasoning-*`
 *     deltas. For OpenAI-compatible servers (LM Studio, vLLM, some
 *     quantized local models) that don't expose reasoning via the
 *     standard `reasoning_content` field and instead emit raw tags in
 *     the content channel.
 *
 *   - **`customBlockTransform(defs)`** — extracts adopter-declared
 *     XML-like tags from `content-delta` text and emits them as
 *     `custom-block-*` deltas. Adopter-facing: gives a way to surface
 *     structured output channels (citations, semantic markers,
 *     completion sentinels) without bespoke per-provider plumbing.
 *
 * Both replace logic that was duplicated inline across
 * OpenAI / Anthropic / Google executors (~120 LOC per provider).
 *
 * @see ./stream-tag-parser.ts
 * @see ./delta-transform.ts
 */

import type { AdapterDelta } from "@agentick/spec-next";

import type { DeltaTransform } from "./delta-transform.js";
import {
  StreamTagParser,
  type StreamTagEvent,
  type StreamTagHandler,
} from "./stream-tag-parser.js";

/**
 * Adopter-declared custom block. The config key is the semantic name;
 * `tag` overrides the actual XML tag matched in the stream (defaults
 * to the config key). `onStart` / `onContent` / `onSelfClosing` are
 * optional side-effect hooks called when the tag is encountered (no
 * effect on the emitted delta stream).
 */
export interface CustomBlockDefinition {
  /** XML tag to intercept; defaults to the config key. */
  readonly tag?: string;
  /** Side-effect hook fired when the opening tag is observed. */
  readonly onStart?: (attrs: Readonly<Record<string, string>>) => void;
  /** Side-effect hook fired when the closing tag is observed. */
  readonly onContent?: (content: string, attrs: Readonly<Record<string, string>>) => void;
  /** Side-effect hook fired for self-closing tags. */
  readonly onSelfClosing?: (attrs: Readonly<Record<string, string>>) => void;
}

// ============================================================================
// Internals — shared tag-router state used by both transforms
// ============================================================================

/**
 * Sentinel `blockIndex` for the reasoning channel reserved by the
 * tag-router. Negative so it sorts BEFORE the assistant's text content
 * block (which starts at 0). Mirrors v1's behavior for vLLM /
 * LM Studio that emit chain-of-thought BEFORE the assistant content.
 */
const ROUTER_REASONING_BLOCK_INDEX = -1;

/** Internal: maps a tag name → routing mode for the parser. */
type TagMode = "reasoning" | "custom-block";

function buildHandlers(customBlocks?: Readonly<Record<string, CustomBlockDefinition>>): {
  tagModes: Map<string, TagMode>;
  handlers: Record<string, StreamTagHandler>;
} {
  const tagModes = new Map<string, TagMode>();
  const handlers: Record<string, StreamTagHandler> = {};
  if (customBlocks) {
    for (const [key, def] of Object.entries(customBlocks)) {
      const tagName = def.tag ?? key;
      tagModes.set(tagName, "custom-block");
      const h: StreamTagHandler = {};
      if (def.onStart) h.onStart = def.onStart;
      if (def.onContent) h.onContent = def.onContent;
      if (def.onSelfClosing) h.onSelfClosing = def.onSelfClosing;
      handlers[tagName] = h;
    }
  }
  return { tagModes, handlers };
}

// ============================================================================
// thinkTagTransform — <think>...</think> → reasoning deltas
// ============================================================================

/**
 * `DeltaTransform` that extracts `<think>...</think>` tags from
 * `content-delta` text and re-emits them as `reasoning-*` deltas.
 *
 * The reasoning content lives at `blockIndex = -1` (sentinel; sorts
 * before the assistant text content block at index 0). Subsequent
 * `reasoning-end` + `reasoning` summary events fire from the base's
 * end-of-stream cleanup.
 */
export function thinkTagTransform(): DeltaTransform {
  const tagModes = new Map<string, TagMode>([["think", "reasoning"]]);
  const parser = new StreamTagParser({ tags: { think: {} } });
  let reasoningStarted = false;

  return {
    process(delta: AdapterDelta): readonly AdapterDelta[] {
      if (delta.type !== "content-delta") return [delta];
      const out: AdapterDelta[] = [];
      for (const ev of parser.process(delta.delta)) {
        handleTagEvent(ev, tagModes, out, () => {
          if (!reasoningStarted) {
            reasoningStarted = true;
            out.push({ type: "reasoning-start", blockIndex: ROUTER_REASONING_BLOCK_INDEX });
          }
        });
      }
      // Replace the original delta with the parsed-out routing.
      return out;
    },
    flush(): readonly AdapterDelta[] {
      const out: AdapterDelta[] = [];
      for (const ev of parser.flush()) {
        handleTagEvent(ev, tagModes, out, () => {
          if (!reasoningStarted) {
            reasoningStarted = true;
            out.push({ type: "reasoning-start", blockIndex: ROUTER_REASONING_BLOCK_INDEX });
          }
        });
      }
      return out;
    },
  };
}

// ============================================================================
// customBlockTransform — adopter-declared tags → custom-block deltas
// ============================================================================

/**
 * `DeltaTransform` that extracts adopter-declared tags from
 * `content-delta` text and emits them as `custom-block-*` deltas. Text
 * outside the tags flows through as `content-delta` unchanged.
 */
export function customBlockTransform(
  defs: Readonly<Record<string, CustomBlockDefinition>>,
): DeltaTransform {
  const { tagModes, handlers } = buildHandlers(defs);
  if (tagModes.size === 0) {
    return { process: (d) => [d], flush: () => [] };
  }
  const parser = new StreamTagParser({ tags: handlers });

  return {
    process(delta: AdapterDelta): readonly AdapterDelta[] {
      if (delta.type !== "content-delta") return [delta];
      const out: AdapterDelta[] = [];
      for (const ev of parser.process(delta.delta)) {
        handleTagEvent(ev, tagModes, out, () => {});
      }
      return out;
    },
    flush(): readonly AdapterDelta[] {
      const out: AdapterDelta[] = [];
      for (const ev of parser.flush()) {
        handleTagEvent(ev, tagModes, out, () => {});
      }
      return out;
    },
  };
}

// ============================================================================
// Shared event handler — translate StreamTagEvent → AdapterDelta[]
// ============================================================================

function handleTagEvent(
  event: StreamTagEvent,
  tagModes: Map<string, TagMode>,
  out: AdapterDelta[],
  onReasoningStart: () => void,
): void {
  if (event.type === "text") {
    if (event.content.length > 0) {
      // Plain text flows back through as content-delta on block 0 (the
      // canonical assistant text block).
      out.push({ type: "content-delta", blockIndex: 0, delta: event.content });
    }
    return;
  }
  const mode = tagModes.get(event.tag) ?? "custom-block";
  if (mode === "reasoning") {
    switch (event.type) {
      case "block-start":
        onReasoningStart();
        break;
      case "block-delta":
        onReasoningStart();
        out.push({
          type: "reasoning-delta",
          blockIndex: ROUTER_REASONING_BLOCK_INDEX,
          delta: event.delta,
        });
        break;
      case "block-end":
        // Symmetric close emitted from base's end-of-stream cleanup
        // (it sees reasoning text in accumulator and synthesizes).
        break;
      case "block":
        // Per-block summary skipped — base synthesizes one final
        // reasoning summary from accumulator.
        break;
    }
    return;
  }
  // mode === "custom-block"
  switch (event.type) {
    case "block-start":
      out.push({ type: "custom-block-start", tag: event.tag, attrs: event.attrs });
      break;
    case "block-delta":
      out.push({ type: "custom-block-delta", tag: event.tag, delta: event.delta });
      break;
    case "block-end":
      out.push({ type: "custom-block-end", tag: event.tag });
      break;
    case "block":
      out.push({
        type: "custom-block",
        tag: event.tag,
        content: event.content,
        attrs: event.attrs,
        ...(event.selfClosing ? { selfClosing: true } : {}),
      });
      break;
  }
}
