/**
 * Intrinsic semantic helpers — pure functions producing `RenderedTree`
 * fragments. The shared vocabulary every framework adapter targets.
 *
 * Each helper takes already-resolved props + (optionally) already-walked
 * children, and returns the IR fragment for that intrinsic. AST-
 * agnostic — the adapter's host-config / commit pipeline decides WHEN
 * to call which helper based on its native AST walk.
 *
 * Example (in compiler-react-next's host-config):
 *
 *   case "section":
 *     return { entries: [sectionEntry(props, childBlocks)] };
 *   case "image":
 *     return { blocks: [imageBlock(props)] };
 *
 * Where "render JSX trees to IR" lives differs by framework — react-
 * reconciler drives a commit pipeline; Angular has change detection;
 * Solid has signals. The HELPERS here are uniform; the CALLING is
 * per-runtime.
 */

import type {
  ContentBlock,
  MediaSource,
  MessageEntry,
  SectionEntry,
  SemanticContentBlock,
  SemanticNode,
} from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

// ============================================================================
// Block-level (inline content)
// ============================================================================

/**
 * Plain text block. Adopters with mixed inline children typically
 * concat before calling.
 */
export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}

/**
 * Heading block — produces a semantic ContentBlock that the formatter
 * harness renders per its target syntax (markdown `# Title`, XML
 * `<h1>Title</h1>`, etc.). The compiler does NOT pre-render markdown
 * — that's the formatter's job. See `@agentick/formatters-next`.
 */
export function headerBlock(level: 1 | 2 | 3 | 4 | 5 | 6, text: string): SemanticContentBlock {
  return semanticBlock({
    semantic: "heading",
    props: { level },
    children: [{ text }],
  });
}

/**
 * Helper to wrap a `SemanticNode` into a `SemanticContentBlock`.
 * Matches the convention used by formatters-next test fixtures —
 * empty top-level `text` with the semantic tree on `semanticNode`.
 */
function semanticBlock(node: SemanticNode): SemanticContentBlock {
  return { type: "text", text: "", semanticNode: node } as SemanticContentBlock;
}

/**
 * Fenced code block. `language` is required by the spec — defaults to
 * `"other"` when the caller doesn't know.
 */
export function codeBlock(text: string, language?: string): ContentBlock {
  return { type: "code", text, language: language ?? "other" };
}

/**
 * JSON data block. Carries `data` (the structured value); the
 * formatter renders it as fenced JSON.
 */
export function jsonBlock(data: unknown): ContentBlock {
  return { type: "json", data };
}

/**
 * Reasoning block — opaque-or-redacted internal chain-of-thought
 * surfaced by some providers. `signature` carries provider-specific
 * verification info; `isRedacted` flags content the provider hid.
 */
export interface ReasoningProps {
  readonly text: string;
  readonly signature?: string;
  readonly isRedacted?: boolean;
  readonly id?: string;
}

export function reasoningBlock(props: ReasoningProps): ContentBlock {
  return {
    type: "reasoning",
    text: props.text,
    ...omitUndefined({
      signature: props.signature,
      isRedacted: props.isRedacted,
      id: props.id,
    }),
  };
}

/**
 * Raw XML block — pre-formatted XML text wrapped as a block.
 */
export function xmlBlockHelper(text: string): ContentBlock {
  return { type: "xml", text };
}

/**
 * Raw HTML block — pre-formatted HTML text wrapped as a block.
 */
export function htmlBlock(text: string): ContentBlock {
  return { type: "html", text };
}

/**
 * CSV block — tabular text with optional header row.
 */
export function csvBlock(text: string, headers?: readonly string[]): ContentBlock {
  return {
    type: "csv",
    text,
    ...omitUndefined({ headers: headers && headers.length > 0 ? headers : undefined }),
  };
}

// ============================================================================
// Media blocks
// ============================================================================

export interface ImageProps {
  readonly source: MediaSource;
  readonly mimeType?: string;
  readonly altText?: string;
  readonly id?: string;
}

export function imageBlock(props: ImageProps): ContentBlock {
  return {
    type: "image",
    source: props.source,
    ...omitUndefined({
      mimeType: props.mimeType as never,
      altText: props.altText,
      id: props.id,
    }),
  };
}

export interface DocumentProps {
  readonly source: MediaSource;
  readonly mimeType?: string;
  readonly title?: string;
  readonly id?: string;
}

export function documentBlock(props: DocumentProps): ContentBlock {
  return {
    type: "document",
    source: props.source,
    ...omitUndefined({
      mimeType: props.mimeType as never,
      title: props.title,
      id: props.id,
    }),
  };
}

export interface AudioProps {
  readonly source: MediaSource;
  readonly mimeType?: string;
  readonly transcript?: string;
  readonly id?: string;
}

export function audioBlock(props: AudioProps): ContentBlock {
  return {
    type: "audio",
    source: props.source,
    ...omitUndefined({
      mimeType: props.mimeType as never,
      transcript: props.transcript,
      id: props.id,
    }),
  };
}

export interface VideoProps {
  readonly source: MediaSource;
  readonly mimeType?: string;
  readonly transcript?: string;
  readonly id?: string;
}

export function videoBlock(props: VideoProps): ContentBlock {
  return {
    type: "video",
    source: props.source,
    ...omitUndefined({
      mimeType: props.mimeType as never,
      transcript: props.transcript,
      id: props.id,
    }),
  };
}

// ============================================================================
// Event blocks (timeline-event content; produced statically from props)
// ============================================================================

export interface UserActionProps {
  readonly action: string;
  readonly actor?: string;
  readonly target?: string;
  readonly details?: Record<string, unknown>;
  readonly text?: string;
  readonly id?: string;
}

export function userActionBlock(props: UserActionProps): ContentBlock {
  return {
    type: "user_action",
    action: props.action,
    ...omitUndefined({
      actor: props.actor,
      target: props.target,
      details: props.details,
      text: props.text,
      id: props.id,
    }),
  };
}

export interface SystemEventProps {
  readonly event: string;
  readonly source?: string;
  readonly data?: Record<string, unknown>;
  readonly text?: string;
  readonly id?: string;
}

export function systemEventBlock(props: SystemEventProps): ContentBlock {
  return {
    type: "system_event",
    event: props.event,
    ...omitUndefined({
      source: props.source,
      data: props.data,
      text: props.text,
      id: props.id,
    }),
  };
}

export interface StateChangeProps {
  readonly entity: string;
  readonly field?: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly trigger?: string;
  readonly text?: string;
  readonly id?: string;
}

export function stateChangeBlock(props: StateChangeProps): ContentBlock {
  return {
    type: "state_change",
    entity: props.entity,
    from: props.from,
    to: props.to,
    ...omitUndefined({
      field: props.field,
      trigger: props.trigger,
      text: props.text,
      id: props.id,
    }),
  };
}

// ============================================================================
// Custom block — adopter-defined tag with arbitrary attrs + content
// ============================================================================

export interface CustomBlockProps {
  readonly tag: string;
  readonly content: string;
  readonly attrs?: Record<string, string>;
  readonly selfClosing?: boolean;
  readonly id?: string;
}

export function customBlock(props: CustomBlockProps): ContentBlock {
  return {
    type: "custom",
    tag: props.tag,
    content: props.content,
    attrs: props.attrs ?? {},
    ...omitUndefined({
      selfClosing: props.selfClosing,
      id: props.id,
    }),
  };
}

// ============================================================================
// Context-level (entries)
// ============================================================================

/**
 * Section entry — a structured context entry with a stable `id` that
 * survives recompiles. `audience` (model | user | both) is a metadata
 * hint the executor MAY use; `priority` (in metadata) lets the
 * executor reorder.
 */
export interface SectionProps {
  readonly id?: string;
  readonly title?: string;
  readonly audience?: "model" | "user" | "both";
  readonly priority?: number;
}

export function sectionEntry(props: SectionProps, content: readonly ContentBlock[]): SectionEntry {
  const id = props.id ?? "anonymous";
  const metadata = omitUndefined({
    audience: props.audience,
    priority: props.priority,
  });
  return {
    kind: "section",
    id,
    content,
    ...omitUndefined({ title: props.title }),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/**
 * Message entry — a role-bearing context entry. `role` is the
 * Agentick semantic role (`"system"`, `"user"`, `"assistant"`, …);
 * mapping to provider role vocabulary is the executor's job.
 */
export interface MessageProps {
  readonly role: MessageEntry["role"];
  readonly id?: string;
}

export function messageEntry(props: MessageProps, content: readonly ContentBlock[]): MessageEntry {
  return {
    kind: "message",
    role: props.role,
    content,
    ...omitUndefined({ id: props.id }),
  };
}
