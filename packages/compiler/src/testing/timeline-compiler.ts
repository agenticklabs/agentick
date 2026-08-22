/**
 * `timelineCompiler()` — a react-free compiler that folds the session
 * timeline into IR, and nothing else.
 *
 * ## When to use
 *
 * A test that drives a REAL model adapter through the REAL loop, where the
 * conversation must actually reach the provider. {@link fakeCompiler} renders
 * an empty tree, so every provider request it produces carries zero messages —
 * fine when a `FakeLanguageModelExecutor` ignores the prompt, false green when
 * the assertion is about the request itself.
 *
 * The fold mirrors `timelineDefaultProjection` in `@agentick/compiler-react`:
 * every `message`-kind entry that is not `visibility: "log"`, in order. The
 * timeline harness is read STRUCTURALLY off `bridges.timeline` — the same
 * duck-typed seam the React binding uses, so this file needs no dependency on
 * `@agentick/timeline`.
 *
 * Sections, tools, knobs, and every other surfacing projection are absent. Any
 * test that needs one of those needs the real `reactCompiler()`.
 */

import { SPEC_VERSION, type HookBridges, type MessageEntry } from "@agentick/spec";

import { defineCompiler } from "../define-compiler.js";

/** Minimal structural view of a message-kind timeline entry. */
interface StructuralMessageEntry {
  readonly kind?: string;
  readonly visibility?: string;
  readonly message?: {
    readonly id?: string;
    readonly role?: string;
    readonly content?: readonly unknown[];
  };
}

function readEntries(bridges: HookBridges | undefined): readonly StructuralMessageEntry[] {
  const timeline = (bridges as { timeline?: unknown } | undefined)?.timeline;
  const read = (timeline as { read?: () => unknown } | undefined)?.read;
  if (typeof read !== "function") return [];
  const snapshot = read.call(timeline) as { entries?: readonly StructuralMessageEntry[] };
  return Array.isArray(snapshot?.entries) ? snapshot.entries : [];
}

export function timelineCompiler(): ReturnType<typeof defineCompiler> {
  let bridges: HookBridges | undefined;
  return defineCompiler({
    mount: async (input) => {
      bridges = input.bridges;
      return { mountId: "timeline-compiler-mount" };
    },
    unmount: async () => {},
    renderTree: async () => {
      const entries: MessageEntry[] = [];
      for (const entry of readEntries(bridges)) {
        if (entry.kind !== "message" || entry.visibility === "log") continue;
        const message = entry.message;
        if (!message || typeof message.role !== "string") continue;
        entries.push({
          kind: "message",
          role: message.role,
          content: (message.content ?? []) as MessageEntry["content"],
          ...(message.id !== undefined ? { id: message.id } : {}),
        });
      }
      return {
        tree: { specVersion: SPEC_VERSION, context: { entries } },
        diagnostics: [],
        iterations: 1,
      };
    },
  });
}
