/** @jsxImportSource react */
/**
 * V2 Content Components
 *
 * Content components that become SemanticContentBlocks.
 */

import React, { type ReactNode } from "react";

// ============================================================
// Text
// ============================================================

export interface TextProps {
  children?: ReactNode;
}

/**
 * Text content block.
 */
export function Text(props: TextProps): React.JSX.Element {
  return <Text {...props} />;
}

(Text as any).$$typeof = Symbol.for("tentickle.host");
(Text as any).displayName = "Text";

// ============================================================
// Code
// ============================================================

export interface CodeProps {
  language?: string;
  children?: string;
}

/**
 * Code block.
 */
export function Code(props: CodeProps): React.JSX.Element {
  return <Code {...props} />;
}

(Code as any).$$typeof = Symbol.for("tentickle.host");
(Code as any).displayName = "Code";

// ============================================================
// Image
// ============================================================

export interface ImageProps {
  src: string;
  alt?: string;
}

/**
 * Image content block.
 */
export function Image(props: ImageProps): React.JSX.Element {
  return <Image {...props} />;
}

(Image as any).$$typeof = Symbol.for("tentickle.host");
(Image as any).displayName = "Image";

// ============================================================
// Json
// ============================================================

export interface JsonProps {
  data?: unknown;
  children?: unknown;
}

/**
 * JSON content block.
 */
export function Json(props: JsonProps): React.JSX.Element {
  return <Json {...props} />;
}

(Json as any).$$typeof = Symbol.for("tentickle.host");
(Json as any).displayName = "Json";

// ============================================================
// Document
// ============================================================

export interface DocumentProps {
  src: string;
  mimeType?: string;
}

/**
 * Document content block.
 */
export function Document(props: DocumentProps): React.JSX.Element {
  return <Document {...props} />;
}

(Document as any).$$typeof = Symbol.for("tentickle.host");
(Document as any).displayName = "Document";

// ============================================================
// Audio
// ============================================================

export interface AudioProps {
  src: string;
  mimeType?: string;
}

/**
 * Audio content block.
 */
export function Audio(props: AudioProps): React.JSX.Element {
  return <Audio {...props} />;
}

(Audio as any).$$typeof = Symbol.for("tentickle.host");
(Audio as any).displayName = "Audio";

// ============================================================
// Video
// ============================================================

export interface VideoProps {
  src: string;
  mimeType?: string;
}

/**
 * Video content block.
 */
export function Video(props: VideoProps): React.JSX.Element {
  return <Video {...props} />;
}

(Video as any).$$typeof = Symbol.for("tentickle.host");
(Video as any).displayName = "Video";
