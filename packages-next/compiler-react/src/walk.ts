/**
 * Post-commit walker. After react-reconciler commits a tree to the
 * container, walk the `HostInstance` children and produce IR via
 * compiler-next's intrinsic helpers.
 *
 * The walker is synchronous. The mount lifecycle around it
 * (`compile.ts`) handles compile-until-stable for `useData` suspends.
 */

import {
  codeBlock,
  headerBlock,
  jsonBlock,
  messageEntry,
  sectionEntry,
  textBlock,
} from "@agentick/compiler-next";
import type { ElementInstance, HostInstance, TextInstance } from "@agentick/reconciler-next";
import type { ContentBlock, ContextEntry, MessageEntry } from "@agentick/spec-next";

export interface WalkResult {
  readonly entries: readonly ContextEntry[];
  readonly blocks: readonly ContentBlock[];
}

const EMPTY: WalkResult = { entries: [], blocks: [] };

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
    return walkText(node);
  }
  return walkElement(node);
}

function walkText(node: TextInstance): WalkResult {
  return { entries: [], blocks: [textBlock(node.text)] };
}

function walkElement(node: ElementInstance): WalkResult {
  // Function/class components don't appear in the post-commit tree —
  // react-reconciler has already evaluated them and only HOST elements
  // remain. `node.type` is the lowercase host-element string.
  const type = node.type;
  if (typeof type !== "string") {
    // Shouldn't happen with react-reconciler; if it does, skip gracefully.
    return walkChildren(node.children);
  }

  return dispatchHost(type, node.props, node.children);
}

/**
 * Shared dispatch — `tag` + props + children → IR fragment.
 *
 * This is the seam reconciler-react-next extends with reactive
 * intrinsic handlers (Tool, MCP, channels). For now it's hard-coded
 * to the static intrinsic set; future iteration may make it
 * registry-driven.
 */
function dispatchHost(
  tag: string,
  props: Readonly<Record<string, unknown>>,
  children: readonly HostInstance[],
): WalkResult {
  const inner = walkChildren(children);

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
      return { entries: inner.entries, blocks: [codeBlock(innerText(inner.blocks), lang)] };
    }
    case "json": {
      return { entries: inner.entries, blocks: [jsonBlock(props.data)] };
    }
    case "text":
    case "p":
    case "paragraph": {
      return inner;
    }
    default:
      throw new Error(
        `compiler-react: unknown host element <${tag}>. Add a handler in the dispatch, ` +
          `or wrap in a function component that returns a supported intrinsic.`,
      );
  }
}

function innerText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function isAudience(v: unknown): v is "model" | "user" | "both" {
  return v === "model" || v === "user" || v === "both";
}

// Silence unused import warning for EMPTY if we ever need it.
void EMPTY;
