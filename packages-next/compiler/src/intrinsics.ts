/**
 * Intrinsic semantic helpers — pure functions producing `RenderedTree`
 * fragments. The shared vocabulary every framework adapter targets.
 *
 * Each helper takes already-resolved props + already-walked children
 * (inner content blocks / entries the adapter's runtime produced) and
 * returns the IR fragment for that intrinsic. AST-agnostic — the
 * adapter's host-config / commit pipeline decides WHEN to call which
 * helper based on its native AST walk.
 *
 * Example (in compiler-react-next's host-config):
 *
 *   case "section":
 *     return { entries: [sectionEntry(props, childBlocks)] };
 *   case "h1":
 *     return { blocks: [headerBlock(1, innerText)] };
 *
 * Where "render JSX trees to IR" lives differs by framework — react-
 * reconciler drives a commit pipeline; Angular has change detection;
 * Solid has signals. The HELPERS here are uniform; the CALLING is
 * per-runtime.
 */

import type {
  ContentBlock,
  MessageEntry,
  SectionEntry,
  SemanticContentBlock,
  SemanticNode,
} from "@agentick/spec-next";

// ────────── Block-level (inline content) ──────────

/**
 * Plain text block. Accepts either a string or a list of strings
 * (joined). Adopters with mixed inline children typically concat
 * before calling.
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
 * `"other"` when the caller doesn't know. Common values:
 * `"typescript"`, `"python"`, `"json"`, `"shell"`, `"sql"`, etc.
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

// ────────── Context-level (entries) ──────────

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
  const metadata: Record<string, unknown> = {};
  if (props.audience !== undefined) metadata.audience = props.audience;
  if (props.priority !== undefined) metadata.priority = props.priority;
  return {
    kind: "section",
    id,
    content,
    ...(props.title !== undefined ? { title: props.title } : {}),
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
    ...(props.id !== undefined ? { id: props.id } : {}),
  };
}
