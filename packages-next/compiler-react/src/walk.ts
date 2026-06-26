/**
 * React-element walker. Pure recursion: function components are
 * called as plain JS; host elements dispatch by tag through
 * `@agentick/compiler-next`'s intrinsic helpers; fragments / arrays
 * flatten transparently.
 *
 * No react-reconciler. Static templates that use only walker-portable
 * APIs (useData) don't need React's reactive scaffold — and hooks
 * that DO need a dispatcher (useState/useEffect/useSignal) throw
 * naturally because React's current-dispatcher isn't set up here.
 * That's exactly the contract from ADR 39.
 *
 * The walker is SYNCHRONOUS. Compile-until-stable lives one layer up
 * in `compile.ts` — it catches thrown Promises from `useData`, awaits
 * them, retries the whole walk.
 */

import {
  codeBlock,
  headerBlock,
  jsonBlock,
  messageEntry,
  sectionEntry,
  textBlock,
} from "@agentick/compiler-next";
import type { ContentBlock, ContextEntry, MessageEntry } from "@agentick/spec-next";
import { Fragment, isValidElement, type ReactNode } from "react";

/**
 * Accumulated output of one walk pass. Mirrors the shape compiler-next
 * uses internally — `entries` are top-level context entries; `blocks`
 * are inline content the parent host element will wrap or pass up.
 */
export interface WalkResult {
  readonly entries: readonly ContextEntry[];
  readonly blocks: readonly ContentBlock[];
}

/**
 * Walk one React node, returning accumulated entries + blocks.
 */
export function walk(node: ReactNode): WalkResult {
  if (node == null || node === false || node === true) return EMPTY;

  if (typeof node === "string") return { entries: [], blocks: [textBlock(node)] };
  if (typeof node === "number") return { entries: [], blocks: [textBlock(String(node))] };

  if (Array.isArray(node)) return walkAll(node);

  if (!isValidElement(node)) {
    // Iterables / other shapes — best-effort coerce to string.
    return { entries: [], blocks: [textBlock(String(node))] };
  }

  const element = node;
  const type = element.type;
  const props = (element.props ?? {}) as Record<string, unknown>;

  if (type === Fragment) {
    return walkChildren(props.children);
  }

  if (typeof type === "function") {
    // Function component: call it, recurse on its output.
    // Class components are not supported in templates.
    const result = (type as (p: unknown) => ReactNode)(props);
    return walk(result);
  }

  if (typeof type === "string") {
    return walkHost(type, props);
  }

  // Forward-refs, lazy, memoized, etc. — not supported in static
  // templates. Throw with a precise error.
  throw new Error(
    `compiler-react: unsupported React element type "${String(type)}". ` +
      `Static templates support: host elements, function components, fragments, strings, numbers, arrays.`,
  );
}

// ────────── Internals ──────────

const EMPTY: WalkResult = { entries: [], blocks: [] };

function walkChildren(children: unknown): WalkResult {
  if (children == null) return EMPTY;
  if (Array.isArray(children)) return walkAll(children);
  return walk(children as ReactNode);
}

function walkAll(nodes: readonly ReactNode[]): WalkResult {
  const entries: ContextEntry[] = [];
  const blocks: ContentBlock[] = [];
  for (const n of nodes) {
    const r = walk(n);
    entries.push(...r.entries);
    blocks.push(...r.blocks);
  }
  return { entries, blocks };
}

function innerText(blocks: readonly ContentBlock[]): string {
  // Best-effort concat of inline text blocks. Non-text blocks lose
  // their fidelity here — heading children that contain a Code block
  // would not round-trip cleanly. Acceptable for the MVP; revisit
  // when concrete templates need it.
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function walkHost(tag: string, props: Record<string, unknown>): WalkResult {
  const inner = walkChildren(props.children);

  switch (tag) {
    case "section": {
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
          // Nested entries inside a section (rare — sections within
          // sections) get hoisted to the top level, matching how
          // RenderedTree models the context as flat.
          ...inner.entries,
        ],
        blocks: [],
      };
    }
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
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      return { entries: inner.entries, blocks: [headerBlock(level, innerText(inner.blocks))] };
    }
    case "code": {
      const lang = typeof props.language === "string" ? props.language : undefined;
      return {
        entries: inner.entries,
        blocks: [codeBlock(innerText(inner.blocks), lang)],
      };
    }
    case "json": {
      return {
        entries: inner.entries,
        blocks: [jsonBlock(props.data)],
      };
    }
    case "text":
    case "p":
    case "paragraph": {
      return inner;
    }
    default:
      throw new Error(
        `compiler-react: unknown host element <${tag}>. Add a handler in walk.ts, or use a function component to wrap a supported intrinsic.`,
      );
  }
}

function isAudience(v: unknown): v is "model" | "user" | "both" {
  return v === "model" || v === "user" || v === "both";
}
