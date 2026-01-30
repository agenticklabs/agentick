import type { ContentBlock, Message, MessageRoles } from "@tentickle/shared";
import React from "react";
import type { JSX } from "react";
import type { JSX as TentickleJSX } from "../jsx-runtime";
import type { StreamEvent } from "../../engine/engine-events";
import type { ComponentBaseProps } from "../jsx-types";

// Helper for createElement
const h = React.createElement;

// Re-export Timeline component from timeline.tsx
export { Timeline, useTimelineContext } from "./timeline";
export type { TimelineProps, TimelineRenderFn, TimelineContextValue } from "./timeline";

/**
 * TimelineWrapper primitive component.
 * Wraps Message components to explicitly declare timeline entries.
 * When used in JSX: <TimelineWrapper><Message role="user" content="..." /></TimelineWrapper>
 *
 * @deprecated Use <Timeline> for rendering conversation history with render props.
 */
export function TimelineWrapper(props: TentickleJSX.IntrinsicElements["timeline"]): JSX.Element {
  // TimelineWrapper is just a Fragment - it doesn't render anything itself
  // The renderer processes its Message children
  return h(React.Fragment, props);
}

/**
 * Entry primitive component.
 * Foundational structural primitive for timeline entries only.
 * Uses discriminated union based on kind to determine data structure.
 *
 * Usage:
 *   <Entry kind="message" message={{ role: 'user', content: [...] }} />
 *   <Entry kind="event" event={{ type: 'user_action', data: {...} }} />
 */
/**
 * Map of entry kinds to their specific data structures.
 * This can be extended via module augmentation:
 *
 * declare module './primitives' {
 *   interface EntryKindMap {
 *     customKind: { customProp: string };
 *   }
 * }
 */
export interface EntryKindMap {
  message: Message;
  event: StreamEvent;
}

/**
 * Union of all entry kinds.
 * Automatically includes all keys from EntryKindMap.
 */
export type EntryKind = keyof EntryKindMap;

/**
 * Common props shared by all entry types.
 */
export interface EntryCommonProps {
  id?: string;
  visibility?: "model" | "observer" | "log";
  tags?: string[];
  metadata?: Record<string, unknown>;
  children?: any;
  formattedContent?: ContentBlock[]; // Cached formatted version
}

/**
 * Entry primitive component props.
 * Uses mapped type to create discriminated union from EntryKindMap.
 *
 * The structure ensures that:
 * - kind="message" requires a `message` property with message-specific data
 * - kind="event" requires an `event` property with event-specific data
 *
 * Usage:
 *   <Entry kind="message" message={{ role: 'user', content: [...] }} />
 *   <Entry kind="event" event={{ type: 'user_action', data: {...} }} />
 *
 * TypeScript will enforce type safety based on the `kind` discriminator.
 */
export type EntryProps = {
  [K in EntryKind]: {
    kind: K;
  } & {
    [P in K]: EntryKindMap[K];
  } & EntryCommonProps;
}[EntryKind];

export function Entry(props: EntryProps): JSX.Element {
  // Use intrinsic "entry" element for react-reconciler compatibility
  // The reconciler's hostConfig will create a TentickleNode for this
  // Type assertion needed because React.createElement doesn't handle discriminated unions well
  return h("entry", props as any);
}

/**
 * Section primitive component.
 * When used in JSX: <Section id="..." content="..." />
 * Returns an intrinsic "section" element for react-reconciler compatibility.
 */
export function Section(props: TentickleJSX.IntrinsicElements["section"]): JSX.Element {
  // Use intrinsic "section" element for react-reconciler compatibility
  return h("section", props);
}

/**
 * Message primitive component props.
 * Allows spreading Message objects directly, plus JSX-specific props.
 *
 * Uses intersection to accept both Message shape and JSX convenience props.
 *
 * Usage:
 *   <Message role="user">Hello</Message>
 *   <Message {...messageObject} tags={['important']} />
 */
export type MessageProps = Partial<Omit<Message, "content" | "role">> & {
  role: MessageRoles; // Required - NO 'grounding' (ephemeral is not a message)
  content?: string | any[] | Message["content"]; // Accepts ContentBlock[] from Message or string/any[] from JSX
  tags?: string[]; // Entry-level props (not part of Message)
  visibility?: "model" | "observer" | "log"; // Entry-level props (not part of Message)
  children?: any; // JSX children, will be collected into content
} & ComponentBaseProps;

/**
 * Message primitive component.
 * Semantic sugar wrapper that wraps Entry with kind="message" for intuitive API.
 *
 * Accepts Message objects via spreading, converts to Entry structure.
 *
 * Usage:
 *   <Message role="user">Hello</Message>
 *   <Message {...messageFromTimeline} tags={['important']} />
 * Compiles to: <Entry kind="message" message={{ role: 'user', content: [...] }} />
 */
export function Message(props: MessageProps): JSX.Element {
  const { role, content, children, id, metadata, tags, visibility, createdAt, updatedAt, ...rest } =
    props;

  // Convert MessageProps to Message structure for EntryKindMap
  // If content is already ContentBlock[], use it; otherwise renderer will convert children
  const message: Message = {
    role,
    content: (content as Message["content"]) || [], // Will be converted to ContentBlock[] by renderer if needed
    id,
    metadata,
    createdAt,
    updatedAt,
  };

  return h(Entry, {
    kind: "message",
    message,
    tags, // Entry-level props
    visibility, // Entry-level props
    ...rest,
    children, // Pass children through - renderer will collect them into message.content
  });
}

/**
 * Tool primitive component.
 * When used in JSX: <Tool definition={myTool} />
 */
export function Tool(props: TentickleJSX.IntrinsicElements["tool"]): JSX.Element {
  // Use intrinsic "tool" element for react-reconciler compatibility
  return h("tool", props);
}

// Re-export Model components
export { Model, ModelOptions } from "./model";
export type { ModelComponentProps, ModelOptionsProps } from "./model";

// Re-export Markdown component
export { Markdown } from "./markdown";

// Re-export semantic primitives
export { H1, H2, H3, Header, Paragraph, List, ListItem, Table, Row, Column } from "./semantic";

// Re-export message role components
export { User, Assistant, System, ToolResult, Event, Ephemeral, Grounding } from "./messages";
export type {
  UserProps,
  AssistantProps,
  SystemProps,
  ToolResultProps,
  EventProps,
  EphemeralProps,
  GroundingProps,
  EphemeralPosition,
  RoleMessageBaseProps,
} from "./messages";

// Re-export event block components
export { UserAction, SystemEvent, StateChange } from "./messages";
export type { UserActionProps, SystemEventProps, StateChangeProps } from "./messages";

// Fragment is already exported from jsx-runtime but we can re-export or use <>
