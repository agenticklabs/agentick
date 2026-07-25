export { FormatScope, Markdown, XML, PlainText } from "./format-scope.js";
export type { FormatScopeProps, NamedFormatScopeProps } from "./format-scope.js";

export { Message } from "./message.js";
export type { MessageProps } from "./message.js";

export { Section } from "./section.js";
export type { SectionProps } from "./section.js";

export { Project } from "./project.js";
export type { ProjectProps } from "./project.js";

export { ProviderTool } from "./provider-tool.js";
export type { ProviderToolProps } from "./provider-tool.js";
export { Output } from "./output.js";
export type { OutputProps } from "./output.js";

// Semantic role + block wrappers — short aliases over the intrinsics.
export { System, User, Assistant, Paragraph, H1, H2, H3 } from "./semantic.js";

// Tree-side guard example — a component that gates the model's tool calls
// behind a confirmation flow (ADR 89 §4).
export { ToolGate } from "./tool-gate.js";
export type { ToolGateProps } from "./tool-gate.js";

// Note: <Knobs>, <Timeline>, and token-budget moved to per-harness
// /react subpaths per ADR 27. Adopters import:
//   <Knobs> + useKnobsContext       from "@agentick/knobs/react"
//   <Timeline> + compactEntries     from "@agentick/timeline/react"
