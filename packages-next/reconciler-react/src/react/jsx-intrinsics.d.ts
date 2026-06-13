/**
 * JSX.IntrinsicElements augmentation for `@agentick/reconciler-react-next`.
 *
 * Declares the v2 reconciler's host intrinsics so adopters (and tests)
 * can write JSX like:
 *
 * ```tsx
 * <message role="user">
 *   <text>hello</text>
 * </message>
 * ```
 *
 * Without this augmentation, TypeScript rejects unknown lowercase tag
 * names with `TS2339: Property 'message' does not exist on type
 * 'JSX.IntrinsicElements'`.
 *
 * Per-prop shapes mirror each contributor's expected `props` interface:
 *   - message → packages-next/reconciler/src/collect/contributors/message.ts
 *   - section → ... /section.ts
 *   - tool    → ... /tool.ts
 *   - etc.
 *
 * Spec sourced from `@agentick/spec-next` so adding a field to a
 * contributor's props makes the JSX prop bag mirror it at compile time.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 */

import type {
  ContentBlock,
  SessionMessageRole,
  ToolDeclaration,
  ToolExposure,
} from "@agentick/spec-next";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      // ────────── Top-level shapes ──────────

      message: {
        readonly id?: string;
        readonly role: SessionMessageRole;
        /**
         * Pre-built content blocks. When non-empty, takes precedence
         * over children — used for re-emitting persisted entries.
         */
        readonly content?: readonly ContentBlock[];
        readonly cache?: Record<string, unknown>;
        readonly providerMetadata?: Record<string, unknown>;
        readonly metadata?: Record<string, unknown>;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      section: {
        readonly id?: string;
        readonly audience?: "user" | "model" | "all";
        readonly title?: string;
        readonly tags?: readonly string[];
        readonly visibility?: "model" | "observer" | "log";
        readonly metadata?: Record<string, unknown>;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      tool: {
        readonly id?: string;
        readonly name: string;
        readonly description?: string;
        readonly inputSchema?: ToolDeclaration["inputSchema"];
        readonly outputSchema?: ToolDeclaration["outputSchema"];
        readonly exposure?: readonly ToolExposure[];
        readonly handlerRef?: string;
        readonly metadata?: Record<string, unknown>;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      // ────────── Content block primitives ──────────

      text: {
        readonly text?: string;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      code: {
        readonly language?: string;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      json: {
        readonly data: unknown;
        readonly key?: React.Key | null;
      };

      image: {
        readonly source:
          | { readonly type: "url"; readonly url: string }
          | { readonly type: "data"; readonly data: string; readonly mediaType: string };
        readonly key?: React.Key | null;
      };

      // ────────── Semantic primitives (markdown / structured prose) ──────────

      header: {
        readonly level?: 1 | 2 | 3 | 4 | 5 | 6;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      paragraph: {
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      list: {
        readonly ordered?: boolean;
        readonly task?: boolean;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      listitem: {
        readonly checked?: boolean;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      table: {
        readonly headers?: readonly string[];
        readonly rows?: readonly (readonly string[])[];
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      row: {
        readonly header?: boolean;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      column: {
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      // ────────── Event blocks ──────────

      useraction: {
        readonly action: string;
        readonly actor?: string;
        readonly target?: string;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      systemevent: {
        readonly event: string;
        readonly source?: string;
        readonly severity?: "info" | "warning" | "error";
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      statechange: {
        readonly entity: string;
        readonly field?: string;
        readonly from: unknown;
        readonly to: unknown;
        readonly trigger?: string;
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };

      ephemeral: {
        readonly position?: "before-user" | "after-user" | "end";
        readonly children?: React.ReactNode;
        readonly key?: React.Key | null;
      };
    }
  }
}

export {};
