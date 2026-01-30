/** @jsxImportSource react */
/**
 * V2 Primitive Components
 *
 * Structural components that map to CompiledStructure.
 */

import React, { type ReactNode } from "react";

// ============================================================
// Section
// ============================================================

export interface SectionProps {
  id: string;
  title?: string;
  visibility?: "model" | "observer" | "log";
  tags?: string[];
  metadata?: Record<string, unknown>;
  children?: ReactNode;
}

/**
 * A named section of content.
 */
export function Section(props: SectionProps): React.JSX.Element {
  // This is a "host" component - the reconciler handles it
  return <Section {...props} />;
}

// Mark as host component
(Section as any).$$typeof = Symbol.for("tentickle.host");
(Section as any).displayName = "Section";

// ============================================================
// Entry / Message
// ============================================================

export interface EntryProps {
  id?: string;
  role?: "user" | "assistant" | "system" | "tool";
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  children?: ReactNode;
}

/**
 * A timeline entry (message in conversation).
 */
export function Entry(props: EntryProps): React.JSX.Element {
  return <Entry {...props} />;
}

(Entry as any).$$typeof = Symbol.for("tentickle.host");
(Entry as any).displayName = "Entry";

/**
 * Alias for Entry.
 */
export const Message = Entry;

// ============================================================
// Tool
// ============================================================

export interface ToolProps {
  name: string;
  description?: string;
  schema?: unknown;
  handler: (...args: unknown[]) => unknown;
}

/**
 * A tool available to the model.
 */
export function Tool(props: ToolProps): React.JSX.Element {
  return <Tool {...props} />;
}

(Tool as any).$$typeof = Symbol.for("tentickle.host");
(Tool as any).displayName = "Tool";

// ============================================================
// Ephemeral
// ============================================================

export interface EphemeralProps {
  position?: "before" | "after" | "inline";
  order?: number;
  metadata?: Record<string, unknown>;
  children?: ReactNode;
}

/**
 * Ephemeral content (not persisted to timeline).
 */
export function Ephemeral(props: EphemeralProps): React.JSX.Element {
  return <Ephemeral {...props} />;
}

(Ephemeral as any).$$typeof = Symbol.for("tentickle.host");
(Ephemeral as any).displayName = "Ephemeral";
