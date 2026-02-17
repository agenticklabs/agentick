import React from "react";
import type { JSX } from "react";
import type { ContentBlock as ContentBlockType, MediaSource } from "@agentick/shared";
import type { CodeLanguage } from "@agentick/shared";
import type { ComponentBaseProps } from "../jsx-types";
import { Expandable } from "../../hooks/expandable";
import { Collapsed } from "./collapsed";
import { autoContentSummary } from "./auto-summary";

// Helper for createElement
const h = React.createElement;

// ============================================================================
// Base Props
// ============================================================================

/**
 * Collapse props shared by all expandable content blocks.
 * When `collapsed` is provided, the block renders an Expandable wrapper
 * that shows a summary by default, expandable via set_knob.
 *
 * - `true`: auto-summarize based on content block type
 * - `string`: use this string as the collapsed summary
 * - `ReactNode`: render this as collapsed content (must produce text)
 */
export interface CollapseProps {
  collapsed?: boolean | string | React.ReactNode;
  collapsedName?: string;
  collapsedGroup?: string;
}

/**
 * Content component primitives for composing Message content.
 * These provide a React-like API for building ContentBlock[].
 */
export interface ContentBlockProps extends ComponentBaseProps, CollapseProps {
  id?: string;
}

// Re-export the type for external use
export type { ContentBlockType };

// ============================================================================
// Helper to strip collapse props before passing to intrinsic elements
// ============================================================================

function stripCollapse<T extends CollapseProps>(props: T): Omit<T, keyof CollapseProps> {
  const { collapsed: _c, collapsedName: _cn, collapsedGroup: _cg, ...rest } = props;
  return rest as any;
}

/**
 * Wrap an intrinsic element in Expandable when collapsed prop is set.
 * Collapsed state renders a Collapsed intrinsic; expanded renders the original block.
 *
 * The `intrinsicType` and `intrinsicProps` are needed for auto-summary
 * when collapsed={true} — the summary is derived from the block type and props.
 */
function withCollapse(
  props: CollapseProps,
  intrinsic: JSX.Element,
  intrinsicType: string,
  intrinsicProps: Record<string, any>,
): JSX.Element {
  if (props.collapsed === undefined || props.collapsed === false) return intrinsic;

  // Derive knob summary (always a string, for set_knob tool description)
  const summary =
    typeof props.collapsed === "string"
      ? props.collapsed
      : autoContentSummary(intrinsicType, intrinsicProps);

  // Derive collapsed children for the Collapsed intrinsic
  const collapsedChildren: React.ReactNode = props.collapsed === true ? summary : props.collapsed;

  return h(Expandable, {
    name: props.collapsedName,
    group: props.collapsedGroup,
    summary,
    children: (expanded: boolean, name: string) =>
      expanded ? intrinsic : h(Collapsed, { name, group: props.collapsedGroup }, collapsedChildren),
  });
}

// ============================================================================
// Text
// ============================================================================

/**
 * Text content block.
 * Usage: <Text>Hello world</Text> or <Text text="Hello" />
 *
 * @example
 * <Text>Hello world</Text>
 * <Text>Hello <b>bold</b> and <inlineCode>code</inlineCode></Text>
 */
export interface TextProps extends ContentBlockProps {
  children?: any;
  text?: string;
}
export function Text(props: TextProps): JSX.Element {
  const stripped = stripCollapse(props);
  return withCollapse(props, h("Text", stripped), "Text", stripped);
}

// ============================================================================
// Image
// ============================================================================

/**
 * Image content block.
 * Usage: <Image source={{ type: 'url', url: '...' }} />
 */
export interface ImageProps extends ContentBlockProps {
  source: MediaSource;
  mimeType?: string;
  altText?: string;
}
export function Image(props: ImageProps): JSX.Element {
  const stripped = stripCollapse(props);
  return withCollapse(props, h("Image", stripped), "Image", stripped);
}

// ============================================================================
// Document
// ============================================================================

/**
 * Document content block.
 * Usage: <Document source={{ type: 'url', url: '...' }} />
 */
export interface DocumentProps extends ContentBlockProps {
  source: MediaSource;
  mimeType?: string;
  title?: string;
}
export function Document(props: DocumentProps): JSX.Element {
  const stripped = stripCollapse(props);
  return withCollapse(props, h("Document", stripped), "Document", stripped);
}

// ============================================================================
// Audio
// ============================================================================

/**
 * Audio content block.
 * Usage: <Audio source={{ type: 'url', url: '...' }} />
 */
export interface AudioProps extends ContentBlockProps {
  source: MediaSource;
  mimeType?: string;
  transcript?: string;
}
export function Audio(props: AudioProps): JSX.Element {
  const stripped = stripCollapse(props);
  return withCollapse(props, h("Audio", stripped), "Audio", stripped);
}

// ============================================================================
// Video
// ============================================================================

/**
 * Video content block.
 * Usage: <Video source={{ type: 'url', url: '...' }} />
 */
export interface VideoProps extends ContentBlockProps {
  source: MediaSource;
  mimeType?: string;
  transcript?: string;
}
export function Video(props: VideoProps): JSX.Element {
  const stripped = stripCollapse(props);
  return withCollapse(props, h("Video", stripped), "Video", stripped);
}

// ============================================================================
// Code
// ============================================================================

/**
 * Code content block.
 * Usage: <Code language="typescript">const x = 1;</Code>
 */
export interface CodeProps extends ContentBlockProps {
  language: CodeLanguage | string;
  children?: string | string[];
  text?: string;
}
export function Code(props: CodeProps): JSX.Element {
  const stripped = stripCollapse(props);
  return withCollapse(props, h("Code", stripped), "Code", stripped);
}

// ============================================================================
// Json
// ============================================================================

/**
 * JSON content block.
 * Usage: <Json data={{ key: 'value' }} />
 */
export interface JsonProps extends ContentBlockProps {
  data?: any;
  children?: string | string[];
  text?: string;
}
export function Json(props: JsonProps): JSX.Element {
  const stripped = stripCollapse(props);
  const childrenText =
    stripped.children !== undefined
      ? typeof stripped.children === "string"
        ? stripped.children
        : stripped.children?.join("") || ""
      : undefined;
  const text = childrenText ?? stripped.text ?? "";
  const intrinsicProps = {
    ...omit(stripped, ["children"]),
    text: text || JSON.stringify(stripped.data),
  };
  const intrinsic = h("Json", intrinsicProps);

  return withCollapse(props, intrinsic, "Json", intrinsicProps);
}

// ============================================================================
// ToolUse
// ============================================================================

/**
 * Tool use content block.
 * Usage: <ToolUse name="shell" toolUseId="call_1" input={{ cmd: "ls" }} />
 */
export interface ToolUseProps extends ContentBlockProps {
  name: string;
  toolUseId: string;
  input?: Record<string, unknown>;
}
export function ToolUse(props: ToolUseProps): JSX.Element {
  const stripped = stripCollapse(props);
  return withCollapse(props, h("ToolUse", stripped), "ToolUse", stripped);
}

// ============================================================================
// Helpers
// ============================================================================

function omit<T, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result: any = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}
