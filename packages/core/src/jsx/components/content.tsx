import React from "react";
import type { JSX } from "react";
import type { ContentBlock as ContentBlockType, MediaSource } from "@tentickle/shared";
import type { CodeLanguage } from "@tentickle/shared";
import type { ComponentBaseProps } from "../jsx-types";

// Helper for createElement
const h = React.createElement;

/**
 * Content component primitives for composing Message content.
 * These provide a React-like API for building ContentBlock[].
 */
export interface ContentBlockProps extends ComponentBaseProps {
  id?: string;
}

/**
 * Helper to create a content block component.
 * This wraps createElement to provide type-safe content block creation.
 */
function createContentBlock<TProps extends ContentBlockProps>(
  block: (props: TProps) => JSX.Element,
  props: TProps,
): JSX.Element {
  return h(block, props);
}

// Re-export the type for external use
export type { ContentBlockType };

/**
 * Text content block.
 * Usage: <Text>Hello world</Text> or <Text text="Hello" />
 *
 * Children take precedence over text prop (React convention - explicit wins).
 * Children can include JSX formatting elements (bold, italic, code, etc.)
 * which will be collected and formatted appropriately.
 *
 * @example
 * // Plain text
 * <Text>Hello world</Text>
 *
 * // With inline formatting
 * <Text>Hello <b>bold</b> and <inlineCode>code</inlineCode></Text>
 *
 * // With dynamic content
 * <Text><b>{isOld ? '[OLD] ' : ''}</b>{message.text}</Text>
 */
export interface TextProps extends ContentBlockProps {
  children?: any; // Allow JSX children for inline formatting
  text?: string;
}
export function Text(props: TextProps): JSX.Element {
  // Pass through - the compiler/extractors will handle JSX children
  // and apply inline formatting during collection
  return createContentBlock<TextProps>(Text, props);
}

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
  return createContentBlock<ImageProps>(Image, props);
}

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
  return createContentBlock<DocumentProps>(Document, props);
}

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
  return createContentBlock<AudioProps>(Audio, props);
}

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
  return createContentBlock<VideoProps>(Video, props);
}

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
  return createContentBlock<CodeProps>(Code, props);
}

/**
 * JSON content block.
 * Usage: <Json data={{ key: 'value' }} />
 *
 * Children take precedence over text prop (React convention - explicit wins).
 */
export interface JsonProps extends ContentBlockProps {
  data?: any;
  children?: string | string[];
  text?: string;
}
export function Json(props: JsonProps): JSX.Element {
  // Children win over props (more explicit, React convention)
  const childrenText =
    props.children !== undefined
      ? typeof props.children === "string"
        ? props.children
        : props.children?.join("") || ""
      : undefined;
  const text = childrenText ?? props.text ?? "";
  return createContentBlock<JsonProps>(Json, {
    ...omit(props, ["children"]),
    text: text || JSON.stringify(props.data),
  });
}

function omit<T, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result: any = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}
