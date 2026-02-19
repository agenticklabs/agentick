import type { ContentBlock, Message, MessageRoles } from "@agentick/shared";
import React, { useDebugValue } from "react";
import type { JSX } from "react";
import type { JSX as AgentickJSX } from "../jsx-runtime";
import type { StreamEvent } from "../../engine/engine-events";
import type { ComponentBaseProps } from "../jsx-types";
import { Expandable } from "../../hooks/expandable";
import { Collapsed } from "./collapsed";
import { autoMessageSummary, autoSectionSummary } from "./auto-summary";
import { useToolProcedure } from "../../tool/tool-procedure";

// Helper for createElement
const h = React.createElement;

// Re-export Timeline component from timeline.tsx
export { Timeline, useTimelineContext } from "./timeline";
export type { TimelineProps, TimelineRenderFn, TimelineContextValue } from "./timeline";

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
  // The reconciler's hostConfig will create a AgentickNode for this
  // Type assertion needed because React.createElement doesn't handle discriminated unions well
  return h("entry", props as any);
}

/**
 * Section primitive component props.
 * Extends intrinsic section props with collapse support.
 */
export type SectionProps = AgentickJSX.IntrinsicElements["section"] & {
  /**
   * Enables collapse behavior.
   * - `true`: auto-summarize from title/id
   * - `string`: use as collapsed summary
   * - `ReactNode`: render as collapsed content (must produce text)
   */
  collapsed?: boolean | string | React.ReactNode;
  /** Explicit knob name for collapse toggle. Auto-generated if omitted. */
  collapsedName?: string;
  /** Group name for batch expansion via set_knob. */
  collapsedGroup?: string;
};

function SectionInner(props: SectionProps): JSX.Element {
  useDebugValue(`Section: ${props.title ?? props.id ?? "untitled"}`);
  return h("section", props);
}

function CollapsibleSection(props: SectionProps): JSX.Element {
  const { collapsed, collapsedName, collapsedGroup, ...sectionProps } = props;

  const summary =
    typeof collapsed === "string"
      ? collapsed
      : autoSectionSummary(sectionProps.title, sectionProps.id);

  const collapsedChildren: React.ReactNode = collapsed === true ? summary : collapsed;

  return h(Expandable, {
    name: collapsedName,
    group: collapsedGroup,
    summary,
    children: (expanded: boolean, name: string) =>
      expanded
        ? h(SectionInner, sectionProps)
        : h(SectionInner, {
            ...sectionProps,
            children: h(Collapsed, { name, group: collapsedGroup }, collapsedChildren),
          }),
  });
}

/**
 * Section primitive component.
 * When used in JSX: <Section id="..." content="..." />
 * Returns an intrinsic "section" element for react-reconciler compatibility.
 *
 * When `collapsed` is provided, enables collapse/expand behavior via knob.
 */
export function Section(props: SectionProps): JSX.Element {
  if (props.collapsed !== undefined && props.collapsed !== false) {
    return h(CollapsibleSection, props);
  }
  return h(SectionInner, props);
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
  /**
   * Enables collapse behavior.
   * - `true`: auto-summarize from role and content
   * - `string`: use as collapsed summary
   * - `ReactNode`: render as collapsed content (must produce text)
   */
  collapsed?: boolean | string | React.ReactNode;
  /** Explicit knob name for collapse toggle. Auto-generated if omitted. */
  collapsedName?: string;
  /** Group name for batch expansion via set_knob. */
  collapsedGroup?: string;
} & ComponentBaseProps;

/**
 * Internal: renders a message entry with useDebugValue.
 */
function MessageInner(props: MessageProps): JSX.Element {
  const { role, content, children, id, metadata, tags, visibility, createdAt, updatedAt, ...rest } =
    props;

  const preview =
    typeof content === "string"
      ? content.slice(0, 30) + (content.length > 30 ? "..." : "")
      : children
        ? "[children]"
        : "[empty]";
  useDebugValue(`${role}: ${preview}`);

  const message: Message = {
    role,
    content: (content as Message["content"]) || [],
    id,
    metadata,
    createdAt,
    updatedAt,
  };

  return h(Entry, {
    kind: "message",
    message,
    tags,
    visibility,
    ...rest,
    children,
  });
}

/**
 * Internal: message with collapse/expand toggle via Expandable.
 * When collapsed, renders MessageInner with summary as children.
 * When expanded (knob toggled), renders MessageInner with original content.
 */
function CollapsibleMessage(props: MessageProps): JSX.Element {
  const { collapsed, collapsedName, collapsedGroup, ...messageProps } = props;

  const summary =
    typeof collapsed === "string"
      ? collapsed
      : autoMessageSummary(messageProps.role, messageProps.content as ContentBlock[]);

  const collapsedChildren: React.ReactNode = collapsed === true ? summary : collapsed;

  return h(Expandable, {
    name: collapsedName,
    group: collapsedGroup,
    summary,
    children: (expanded: boolean, name: string) =>
      expanded
        ? h(MessageInner, messageProps)
        : h(MessageInner, {
            ...messageProps,
            content: undefined,
            children: h(Collapsed, { name, group: collapsedGroup }, collapsedChildren),
          }),
  });
}

/**
 * Message primitive component.
 *
 * Accepts Message objects via spreading, converts to Entry structure.
 * When `collapsed` is provided, enables collapse/expand behavior via knob.
 *
 * Usage:
 *   <Message role="user">Hello</Message>
 *   <Message {...messageFromTimeline} tags={['important']} />
 *   <Message {...msg} collapsed="[ref:3] user asked about weather" />
 * Compiles to: <Entry kind="message" message={{ role: 'user', content: [...] }} />
 */
export function Message(props: MessageProps): JSX.Element {
  if (props.collapsed !== undefined && props.collapsed !== false) {
    return h(CollapsibleMessage, props);
  }
  return h(MessageInner, props);
}

/**
 * Tool primitive component.
 * When used in JSX: <Tool definition={myTool} />
 */
export function Tool(props: AgentickJSX.IntrinsicElements["tool"]): JSX.Element {
  useDebugValue(`Tool: ${props.name ?? "unnamed"}`);
  const wrappedHandler = useToolProcedure(props.handler, props.name ?? "unnamed");
  return h("tool", { ...props, handler: wrappedHandler });
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
