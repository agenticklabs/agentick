/**
 * # Agentick JSX
 *
 * JSX runtime and components for building Agentick agents declaratively.
 * Use familiar React-like syntax to define agent behavior.
 *
 * ## Features
 *
 * - **JSX Runtime** - Custom JSX implementation for Agentick
 * - **Message Components** - User, Assistant, System, ToolResult
 * - **Semantic Components** - H1, H2, Paragraph, List, Table, etc.
 * - **Primitives** - Timeline, Section, Model, Markdown
 * - **Harness** - Sub-agent execution
 *
 * ## Quick Start
 *
 * ```tsx
 * import { User, System, Assistant } from 'agentick';
 *
 * const MyAgent = () => (
 *   <>
 *     <System>You are a helpful assistant.</System>
 *     <User>Hello!</User>
 *   </>
 * );
 * ```
 *
 * ## Message Components
 *
 * ```tsx
 * <User>User message content</User>
 * <Assistant>Assistant response</Assistant>
 * <System>System instructions</System>
 * <ToolResult toolUseId="123" isError={false}>Result</ToolResult>
 * ```
 *
 * ## Semantic Components
 *
 * ```tsx
 * <H1>Title</H1>
 * <Paragraph>Content</Paragraph>
 * <List>
 *   <ListItem>Item 1</ListItem>
 *   <ListItem>Item 2</ListItem>
 * </List>
 * ```
 *
 * @see {@link User} - User message component
 * @see {@link System} - System message component
 *
 * @module agentick/jsx
 */

// JSX Runtime
export * from "./jsx-runtime";
export type { JSX } from "./jsx-runtime";

// Components
export * from "./components";

// Harness (Mark II sub-agent execution)
export { Harness, HarnessComponent, getHarnessContext } from "./components/harness";
export type { HarnessProps, HarnessContext } from "./components/harness";
