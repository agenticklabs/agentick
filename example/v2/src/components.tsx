/**
 * Minimal JSX wrappers for v2 reconciler intrinsics.
 *
 * `@agentick/reconciler-react-next` wires lowercase intrinsics — `<section>`,
 * `<message>`, `<tool>`, content-block elements — via its built-in
 * contributor registry. The v1 user-facing wrappers (`<Section>`, `<H1>`,
 * `<Tool>`, etc.) haven't been promoted into a v2 package yet, so this
 * example defines its own.
 *
 * Surfacing this gap is one purpose of the example — these wrappers
 * should graduate into `@agentick/components` (or similar) once their
 * shape settles.
 */

import React, { type ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Headings
// ─────────────────────────────────────────────────────────────────────────────

export function H1({ children }: { children?: ReactNode }) {
  return React.createElement("heading", { level: 1 }, children);
}
export function H2({ children }: { children?: ReactNode }) {
  return React.createElement("heading", { level: 2 }, children);
}
export function H3({ children }: { children?: ReactNode }) {
  return React.createElement("heading", { level: 3 }, children);
}

// ─────────────────────────────────────────────────────────────────────────────
// Block elements
// ─────────────────────────────────────────────────────────────────────────────

export function Paragraph({ children }: { children?: ReactNode }) {
  return React.createElement("paragraph", null, children);
}

export interface SectionProps {
  id: string;
  title?: string;
  audience?: "model" | "user";
  children?: ReactNode;
}
export function Section({ id, title, audience, children }: SectionProps) {
  return React.createElement("section", { id, title, audience }, children);
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export function Message({ role, children }: { role: MessageRole; children?: ReactNode }) {
  return React.createElement("message", { role }, children);
}
export const System = ({ children }: { children?: ReactNode }) => (
  <Message role="system">{children}</Message>
);
export const User = ({ children }: { children?: ReactNode }) => (
  <Message role="user">{children}</Message>
);
export const Assistant = ({ children }: { children?: ReactNode }) => (
  <Message role="assistant">{children}</Message>
);

// ─────────────────────────────────────────────────────────────────────────────
// Content blocks
// ─────────────────────────────────────────────────────────────────────────────

export function Text({ children }: { children?: ReactNode }) {
  return React.createElement("text", null, children);
}
export function Code({ language, children }: { language: string; children?: ReactNode }) {
  return React.createElement("code", { language }, children);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool declaration
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolProps {
  id: string;
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  exposure: readonly ("model" | "user")[];
  handlerRef: string;
  annotations?: Readonly<Record<string, unknown>>;
}
export function Tool(props: ToolProps) {
  return React.createElement("tool", props);
}
