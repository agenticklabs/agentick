/**
 * React JSX Type Augmentation for Agentick
 *
 * This file extends React's JSX namespace to include Agentick's
 * intrinsic elements (section, entry, tool, message, etc.)
 *
 * This allows TypeScript to properly type-check Agentick JSX when
 * using React's JSX runtime.
 */

import type z from "zod";
import type { ToolClass, ExecutableTool } from "../tool/tool";
import type { ContentBlock, MessageRoles, ToolExecutionType } from "@agentick/shared";
import type { EntryKindMap } from "./components/primitives";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      // Core Agentick elements
      entry: {
        kind: keyof EntryKindMap;
        children?: React.ReactNode;
        tags?: string[];
        visibility?: "model" | "observer" | "log";
        metadata?: Record<string, unknown>;
      } & Partial<EntryKindMap[keyof EntryKindMap]>;

      section: {
        id?: string;
        audience?: "user" | "model" | "all";
        content?: any;
        title?: string;
        tags?: string[];
        visibility?: "model" | "observer" | "log";
        metadata?: Record<string, unknown>;
        children?: React.ReactNode;
      };

      timeline: {
        children?: React.ReactNode;
      };

      message: {
        id?: string;
        role: MessageRoles;
        content?: string | ContentBlock[];
        tags?: string[];
        visibility?: "model" | "observer" | "log";
        metadata?: Record<string, unknown>;
        children?: React.ReactNode;
      };

      tool: {
        definition?: ToolClass | ExecutableTool | string;
        name?: string;
        description?: string;
        input?: z.ZodSchema;
        executionType?: ToolExecutionType;
      };

      // Content block primitives
      text: {
        text?: string;
        children?: React.ReactNode;
      };

      // Semantic primitives (for prompt formatting)
      header: {
        level?: 1 | 2 | 3 | 4 | 5 | 6;
        children?: React.ReactNode;
      };

      paragraph: {
        children?: React.ReactNode;
      };

      list: {
        ordered?: boolean;
        children?: React.ReactNode;
      };

      listitem: {
        children?: React.ReactNode;
      };

      table: {
        children?: React.ReactNode;
      };

      row: {
        header?: boolean;
        children?: React.ReactNode;
      };

      column: {
        children?: React.ReactNode;
      };

      // Inline formatting (most already exist in React's JSX)
      inlineCode: {
        children?: React.ReactNode;
      };

      // Renderer components
      markdown: {
        flavor?: "github" | "commonmark" | "gfm";
        children?: React.ReactNode;
      };

      // Event block components
      useraction: {
        action: string;
        actor?: string;
        target?: string;
        children?: React.ReactNode;
      };

      systemevent: {
        event: string;
        source?: string;
        severity?: "info" | "warning" | "error";
        children?: React.ReactNode;
      };

      statechange: {
        entity: string;
        field?: string;
        from: any;
        to: any;
        trigger?: string;
        children?: React.ReactNode;
      };

      ephemeral: {
        position?: "before-user" | "after-user" | "end";
        children?: React.ReactNode;
      };
    }
  }
}

export {};
