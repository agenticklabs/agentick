/**
 * V2 Components
 */

// Structural primitives
export {
  Section,
  Entry,
  Message,
  Tool,
  Ephemeral,
  type SectionProps,
  type EntryProps,
  type ToolProps,
  type EphemeralProps,
} from "./primitives";

// Content blocks
export {
  Text,
  Code,
  Image,
  Json,
  Document,
  Audio,
  Video,
  type TextProps,
  type CodeProps,
  type ImageProps,
  type JsonProps,
  type DocumentProps,
  type AudioProps,
  type VideoProps,
} from "./content";

// Renderer wrappers
export {
  Markdown,
  XML,
  createRendererComponent,
  type MarkdownProps,
  type XMLProps,
} from "./renderers";
