/**
 * Post-commit walker. After react-reconciler commits a tree to the
 * container, walk the `HostInstance` children and produce IR via
 * compiler-next's intrinsic helpers.
 *
 * The walker is synchronous. The mount lifecycle around it
 * (`compile.ts`) handles compile-until-stable for `useData` suspends.
 *
 * Two recursion modes:
 *  - `"blocks"` (default) — accumulate ContentBlock[] for inline
 *    content + ContextEntry[] for sections/messages.
 *  - `"semantic"` — entered when we hit a semantic-html intrinsic
 *    (e.g., `<strong>`, `<em>`, `<ul>`, …). Accumulates SemanticNode[]
 *    instead — used to build the NESTED tree inside a
 *    SemanticContentBlock. Non-text, non-semantic children are
 *    dropped per the semantic-html contract (block-level content
 *    inside `<strong>` is a misuse; silent drop is safer than crash).
 */

import {
  audioBlock,
  codeBlock,
  csvBlock,
  customBlock,
  documentBlock,
  getSemanticHtmlEntry,
  htmlBlock,
  imageBlock,
  isSemanticHtmlTag,
  jsonBlock,
  messageEntry,
  reasoningBlock,
  sectionEntry,
  semanticBlock,
  semanticNode,
  stateChangeBlock,
  systemEventBlock,
  textBlock,
  userActionBlock,
  videoBlock,
  xmlBlock,
} from "@agentick/compiler-next";
import type { ElementInstance, HostInstance, TextInstance } from "@agentick/reconciler-next";
import type {
  AudioMimeType,
  ContentBlock,
  ContextEntry,
  DocumentMimeType,
  ImageMimeType,
  MediaSource,
  MessageEntry,
  SemanticNode,
  VideoMimeType,
} from "@agentick/spec-next";

export interface WalkResult {
  readonly entries: readonly ContextEntry[];
  readonly blocks: readonly ContentBlock[];
}

/**
 * Walk the children of a container (or any HostInstance with children)
 * and produce accumulated entries + blocks.
 */
export function walkChildren(children: readonly HostInstance[]): WalkResult {
  const entries: ContextEntry[] = [];
  const blocks: ContentBlock[] = [];
  for (const child of children) {
    const r = walkNode(child);
    entries.push(...r.entries);
    blocks.push(...r.blocks);
  }
  return { entries, blocks };
}

function walkNode(node: HostInstance): WalkResult {
  if (node.kind === "text") {
    return { entries: [], blocks: [textBlock((node as TextInstance).text)] };
  }
  return walkElement(node);
}

function walkElement(node: ElementInstance): WalkResult {
  const type = node.type;
  if (typeof type !== "string") {
    // Function/class components are already evaluated by react-reconciler
    // and won't appear here. Defensive: recurse children gracefully.
    return walkChildren(node.children);
  }

  // Semantic-html intrinsic? Switch to SemanticNode-mode recursion.
  if (isSemanticHtmlTag(type)) {
    return walkSemanticHtml(type, node.props, node.children);
  }

  return dispatchHost(type, node.props, node.children);
}

// ────────── Block-mode dispatch (the default) ──────────

function dispatchHost(
  tag: string,
  props: Readonly<Record<string, unknown>>,
  children: readonly HostInstance[],
): WalkResult {
  const inner = walkChildren(children);

  switch (tag) {
    // ── Context entries ──
    case "section":
      return {
        entries: [
          sectionEntry(
            {
              id: typeof props.id === "string" ? props.id : "anonymous",
              ...(typeof props.title === "string" ? { title: props.title } : {}),
              ...(isAudience(props.audience) ? { audience: props.audience } : {}),
              ...(typeof props.priority === "number" ? { priority: props.priority } : {}),
            },
            inner.blocks,
          ),
          ...inner.entries,
        ],
        blocks: [],
      };

    case "message":
    case "system":
    case "user":
    case "assistant":
    case "tool": {
      const role: MessageEntry["role"] = (
        tag === "message" ? (typeof props.role === "string" ? props.role : "user") : tag
      ) as MessageEntry["role"];
      return {
        entries: [
          messageEntry(
            { role, ...(typeof props.id === "string" ? { id: props.id } : {}) },
            inner.blocks,
          ),
          ...inner.entries,
        ],
        blocks: [],
      };
    }

    // ── Native ContentBlocks ──
    case "code":
      return {
        entries: inner.entries,
        blocks: [
          codeBlock(
            innerText(inner.blocks),
            typeof props.language === "string" ? props.language : undefined,
          ),
        ],
      };

    case "json":
      return { entries: inner.entries, blocks: [jsonBlock(props.data)] };

    case "xml-block":
      return { entries: inner.entries, blocks: [xmlBlock(innerText(inner.blocks))] };

    case "html-block":
      return { entries: inner.entries, blocks: [htmlBlock(innerText(inner.blocks))] };

    case "csv-block":
      return {
        entries: inner.entries,
        blocks: [
          csvBlock(
            innerText(inner.blocks),
            Array.isArray(props.headers) ? (props.headers as readonly string[]) : undefined,
          ),
        ],
      };

    case "reasoning":
      return {
        entries: inner.entries,
        blocks: [
          reasoningBlock({
            text: innerText(inner.blocks),
            ...(typeof props.signature === "string" ? { signature: props.signature } : {}),
            ...(typeof props.isRedacted === "boolean" ? { isRedacted: props.isRedacted } : {}),
            ...(typeof props.id === "string" ? { id: props.id } : {}),
          }),
        ],
      };

    // ── Media ──
    case "image":
      return (
        needsSource(props, tag, inner.entries) ?? {
          entries: inner.entries,
          blocks: [
            imageBlock({
              source: props.source as MediaSource,
              ...(typeof props.mimeType === "string"
                ? { mimeType: props.mimeType as ImageMimeType }
                : {}),
              ...(typeof props.altText === "string" ? { altText: props.altText } : {}),
              ...(typeof props.id === "string" ? { id: props.id } : {}),
            }),
          ],
        }
      );

    case "audio":
      return (
        needsSource(props, tag, inner.entries) ?? {
          entries: inner.entries,
          blocks: [
            audioBlock({
              source: props.source as MediaSource,
              ...(typeof props.mimeType === "string"
                ? { mimeType: props.mimeType as AudioMimeType }
                : {}),
              ...(typeof props.transcript === "string" ? { transcript: props.transcript } : {}),
              ...(typeof props.id === "string" ? { id: props.id } : {}),
            }),
          ],
        }
      );

    case "video":
      return (
        needsSource(props, tag, inner.entries) ?? {
          entries: inner.entries,
          blocks: [
            videoBlock({
              source: props.source as MediaSource,
              ...(typeof props.mimeType === "string"
                ? { mimeType: props.mimeType as VideoMimeType }
                : {}),
              ...(typeof props.transcript === "string" ? { transcript: props.transcript } : {}),
              ...(typeof props.id === "string" ? { id: props.id } : {}),
            }),
          ],
        }
      );

    case "document":
      return (
        needsSource(props, tag, inner.entries) ?? {
          entries: inner.entries,
          blocks: [
            documentBlock({
              source: props.source as MediaSource,
              ...(typeof props.mimeType === "string"
                ? { mimeType: props.mimeType as DocumentMimeType }
                : {}),
              ...(typeof props.title === "string" ? { title: props.title } : {}),
              ...(typeof props.id === "string" ? { id: props.id } : {}),
            }),
          ],
        }
      );

    // ── Event blocks ──
    case "user_action":
      return typeof props.action === "string"
        ? {
            entries: inner.entries,
            blocks: [
              userActionBlock({
                action: props.action,
                ...(typeof props.actor === "string" ? { actor: props.actor } : {}),
                ...(typeof props.target === "string" ? { target: props.target } : {}),
                ...(isRecord(props.details) ? { details: props.details } : {}),
                ...(typeof props.text === "string" ? { text: props.text } : {}),
                ...(typeof props.id === "string" ? { id: props.id } : {}),
              }),
            ],
          }
        : { entries: inner.entries, blocks: [] };

    case "system_event":
      return typeof props.event === "string"
        ? {
            entries: inner.entries,
            blocks: [
              systemEventBlock({
                event: props.event,
                ...(typeof props.source === "string" ? { source: props.source } : {}),
                ...(isRecord(props.data) ? { data: props.data } : {}),
                ...(typeof props.text === "string" ? { text: props.text } : {}),
                ...(typeof props.id === "string" ? { id: props.id } : {}),
              }),
            ],
          }
        : { entries: inner.entries, blocks: [] };

    case "state_change":
      return typeof props.entity === "string"
        ? {
            entries: inner.entries,
            blocks: [
              stateChangeBlock({
                entity: props.entity,
                from: props.from,
                to: props.to,
                ...(typeof props.field === "string" ? { field: props.field } : {}),
                ...(typeof props.trigger === "string" ? { trigger: props.trigger } : {}),
                ...(typeof props.text === "string" ? { text: props.text } : {}),
                ...(typeof props.id === "string" ? { id: props.id } : {}),
              }),
            ],
          }
        : { entries: inner.entries, blocks: [] };

    // ── Custom block ──
    case "custom":
      return typeof props.tag === "string" && typeof props.content === "string"
        ? {
            entries: inner.entries,
            blocks: [
              customBlock({
                tag: props.tag,
                content: props.content,
                ...(isStringRecord(props.attrs) ? { attrs: props.attrs } : {}),
                ...(typeof props.selfClosing === "boolean"
                  ? { selfClosing: props.selfClosing }
                  : {}),
                ...(typeof props.id === "string" ? { id: props.id } : {}),
              }),
            ],
          }
        : { entries: inner.entries, blocks: [] };

    // ── Pass-through (block-level inert wrappers) ──
    case "text":
      return inner;

    default:
      throw new Error(
        `compiler-react: unknown host element <${tag}>. Add a handler in the dispatch, ` +
          `or wrap in a function component that returns a supported intrinsic.`,
      );
  }
}

// ────────── Semantic-mode recursion ──────────

/**
 * Walk a semantic-html tag → SemanticContentBlock with a nested
 * SemanticNode tree. Children recurse as SemanticNode[]; non-semantic
 * descendants are dropped per the semantic-html contract.
 */
function walkSemanticHtml(
  tag: string,
  props: Readonly<Record<string, unknown>>,
  children: readonly HostInstance[],
): WalkResult {
  const entry = getSemanticHtmlEntry(tag);
  // isSemanticHtmlTag was true above, so entry is defined.
  if (!entry) return { entries: [], blocks: [] };

  const semanticChildren = walkAsSemanticNodes(children);
  const mappedProps = entry.propsMapper?.(props);
  const node: SemanticNode = semanticNode(entry.semantic, semanticChildren, mappedProps);
  return { entries: [], blocks: [semanticBlock(node)] };
}

function walkAsSemanticNodes(children: readonly HostInstance[]): SemanticNode[] {
  const out: SemanticNode[] = [];
  for (const child of children) {
    if (child.kind === "text") {
      if (child.text.length > 0) out.push({ text: child.text });
      continue;
    }
    const type = (child as ElementInstance).type;
    if (typeof type !== "string") continue;

    if (isSemanticHtmlTag(type)) {
      const entry = getSemanticHtmlEntry(type)!;
      const props = (child as ElementInstance).props;
      const mapped = entry.propsMapper?.(props);
      out.push(
        semanticNode(
          entry.semantic,
          walkAsSemanticNodes((child as ElementInstance).children),
          mapped,
        ),
      );
      continue;
    }

    // Non-semantic-html element inside a semantic context — silently
    // drop per the semantic-html contract (block-level inside inline
    // is a misuse; safer to drop than crash).
  }
  return out;
}

// ────────── Helpers ──────────

function innerText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function isAudience(v: unknown): v is "model" | "user" | "both" {
  return v === "model" || v === "user" || v === "both";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isRecord(v)) return false;
  for (const k in v) {
    if (typeof v[k] !== "string") return false;
  }
  return true;
}

/**
 * Source-required media tags emit nothing (silent drop) when `source`
 * is missing. Returning the inner-only WalkResult preserves any child
 * entries the user might have included alongside the broken media tag.
 */
function needsSource(
  props: Readonly<Record<string, unknown>>,
  _tag: string,
  innerEntries: readonly ContextEntry[],
): WalkResult | undefined {
  if (!isRecord(props.source)) {
    return { entries: innerEntries, blocks: [] };
  }
  return undefined;
}
