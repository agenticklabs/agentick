/**
 * Message Role Components
 *
 * Semantic components for each message role.
 * These are sugar wrappers around the Message primitive with role pre-set.
 *
 * Usage:
 *   <User>What's the weather?</User>
 *   <Assistant>It's sunny today.</Assistant>
 *   <System>You are a helpful assistant.</System>
 *   <Ephemeral position="before-user">Current state: ...</Ephemeral>
 *   <Event>User completed checkout</Event>
 *   <ToolResult toolCallId="..." name="weather">Sunny, 72°F</ToolResult>
 */

import React, { useDebugValue } from "react";
import type { JSX } from "react";
import type { ContentBlock, EventAllowedBlock } from "@agentick/shared";
import { Message as MessagePrimitive, type MessageProps } from "./primitives.js";
import type { EphemeralPosition } from "../../com/types.js";

// Helper for createElement
const h = React.createElement;

// ============================================================================
// Common Props
// ============================================================================

/**
 * Base props shared by all role-specific message components.
 */
export interface RoleMessageBaseProps {
  /** Unique identifier for the message */
  id?: string;
  /** Message content - can be string, ContentBlock[], or JSX children */
  content?: string | ContentBlock[];
  /** JSX children - will be collected into content */
  children?: any;
  /** Tags for categorization/filtering */
  tags?: string[];
  /** Visibility scope */
  visibility?: "model" | "observer" | "log";
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// User Component
// ============================================================================

export interface UserProps extends RoleMessageBaseProps {}

/**
 * User message component.
 *
 * @example
 * <User>What's the weather today?</User>
 * <User content="Hello" tags={['greeting']} />
 */
export function User(props: UserProps) {
  const { content, children, ...rest } = props;
  useDebugValue("User message");
  return h(MessagePrimitive, {
    role: "user",
    content,
    children,
    ...rest,
  } as MessageProps);
}

// ============================================================================
// Assistant Component
// ============================================================================

export interface AssistantProps extends RoleMessageBaseProps {}

/**
 * Assistant message component.
 *
 * @example
 * <Assistant>The weather is sunny today.</Assistant>
 * <Assistant content={responseBlocks} />
 */
export function Assistant(props: AssistantProps) {
  const { content, children, ...rest } = props;
  useDebugValue("Assistant message");
  return h(MessagePrimitive, {
    role: "assistant",
    content,
    children,
    ...rest,
  } as MessageProps);
}

// ============================================================================
// System Component
// ============================================================================

export interface SystemProps extends RoleMessageBaseProps {}

/**
 * System message component.
 *
 * For static instructions and role definitions.
 * For dynamic state/context, consider using <Grounding> instead.
 *
 * @example
 * <System>You are a helpful assistant.</System>
 */
export function System(props: SystemProps) {
  const { content, children, ...rest } = props;
  useDebugValue("System prompt");
  return h(MessagePrimitive, {
    role: "system",
    content,
    children,
    ...rest,
  } as MessageProps);
}

// ============================================================================
// ToolResult Component
// ============================================================================

export interface ToolResultProps extends RoleMessageBaseProps {
  /** The ID of the tool call this result responds to */
  toolCallId: string;
  /** The name of the tool */
  name?: string;
  /** Whether this result represents an error */
  isError?: boolean;
}

/**
 * Tool result message component.
 *
 * @example
 * <ToolResult toolCallId="call_123" name="weather">
 *   {"temperature": 72, "condition": "sunny"}
 * </ToolResult>
 */
export function ToolResult(props: ToolResultProps) {
  const { content, children, toolCallId, name, isError, ...rest } = props;
  useDebugValue(`ToolResult: ${name ?? toolCallId}`);
  return h(MessagePrimitive, {
    role: "tool",
    content,
    children,
    metadata: {
      ...rest.metadata,
      tool_call_id: toolCallId,
      tool_name: name,
      isError: isError,
    },
    ...rest,
  } as MessageProps);
}

// ============================================================================
// Event Component
// ============================================================================

export interface EventProps extends RoleMessageBaseProps {
  /** Event type for categorization */
  eventType?: string;
  /** Content restricted to event-allowed blocks */
  content?: EventAllowedBlock[] | string;
}

/**
 * Event message component.
 *
 * For recording application events that are part of the conversation history.
 * Events are persisted and represent things that happened (user actions,
 * system events, state changes).
 *
 * Use with event block components (UserAction, SystemEvent, StateChange) for
 * semantic structure with formatted text.
 *
 * @example
 * <Event>
 *   <UserAction action="checkout" actor="user">
 *     User initiated checkout at {timestamp}
 *   </UserAction>
 * </Event>
 *
 * <Event>
 *   <SystemEvent event="payment_processed" source="stripe">
 *     Payment of $99.00 processed successfully
 *   </SystemEvent>
 * </Event>
 */
export function Event(props: EventProps) {
  const { content, children, eventType, ...rest } = props;
  useDebugValue(`Event: ${eventType ?? "generic"}`);
  return h(MessagePrimitive, {
    role: "event",
    content,
    children,
    metadata: {
      ...rest.metadata,
      event_type: eventType,
    },
    ...rest,
  } as MessageProps);
}

// ============================================================================
// Event Block Components
// ============================================================================

export interface UserActionProps {
  /** The action performed */
  action: string;
  /** Who performed the action */
  actor?: string;
  /** Target of the action */
  target?: string;
  /** Additional details */
  details?: Record<string, any>;
  /** Formatted text (from children) */
  children?: string;
}

/**
 * User action block component.
 *
 * Creates a semantic user_action block with formatted text from children.
 * Use inside <Event> messages.
 *
 * @example
 * <Event>
 *   <UserAction action="add_to_cart" actor="user" target="product-123">
 *     User added "Widget Pro" to cart
 *   </UserAction>
 * </Event>
 */
export function UserAction(props: UserActionProps): JSX.Element {
  return h("UserAction", props);
}

export interface SystemEventProps {
  /** The event that occurred */
  event: string;
  /** Source system/component */
  source?: string;
  /** Additional event data */
  data?: Record<string, any>;
  /** Formatted text (from children) */
  children?: string;
}

/**
 * System event block component.
 *
 * Creates a semantic system_event block with formatted text from children.
 * Use inside <Event> messages.
 *
 * @example
 * <Event>
 *   <SystemEvent event="order_created" source="order-service">
 *     Order #12345 created with 3 items
 *   </SystemEvent>
 * </Event>
 */
export function SystemEvent(props: SystemEventProps): JSX.Element {
  return h("SystemEvent", props);
}

export interface StateChangeProps {
  /** The entity that changed */
  entity: string;
  /** The field that changed */
  field?: string;
  /** Previous value */
  from: any;
  /** New value */
  to: any;
  /** What triggered the change */
  trigger?: string;
  /** Formatted text (from children) */
  children?: string;
}

/**
 * State change block component.
 *
 * Creates a semantic state_change block with formatted text from children.
 * Use inside <Event> messages.
 *
 * @example
 * <Event>
 *   <StateChange entity="order" field="status" from="pending" to="shipped" trigger="fulfillment">
 *     Order status changed from pending to shipped
 *   </StateChange>
 * </Event>
 */
export function StateChange(props: StateChangeProps): JSX.Element {
  return h("StateChange", props);
}

// ============================================================================
// Ephemeral Component (Primitive)
// ============================================================================

// Re-export EphemeralPosition from com/types for convenience
export type { EphemeralPosition } from "../../com/types.js";

export interface EphemeralProps {
  /**
   * Type/category of ephemeral content.
   * Used for semantic categorization and can be used by model config
   * to apply type-specific formatting (delimiters, etc.)
   */
  type?: string;

  /** Ephemeral content - can be string, ContentBlock[], or JSX children */
  content?: string | ContentBlock[];

  /** JSX children - will be collected into content */
  children?: any;

  /**
   * Position in the message list (CSS-inspired).
   * @default 'end'
   */
  position?: EphemeralPosition;

  /**
   * Ordering within the position group.
   * Lower numbers appear first.
   * @default 0
   */
  order?: number;

  /** Optional identifier for debugging/tracing */
  id?: string;

  /** Tags for categorization/filtering */
  tags?: string[];

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Ephemeral content primitive.
 *
 * Ephemeral content is NOT persisted - it provides current state/context
 * to the model but is not part of the conversation history. It is rebuilt
 * fresh each tick.
 *
 * The compiler recognizes this component and adds its content to
 * `ctx.ephemeral` rather than the timeline.
 *
 * @example
 * <Ephemeral type="account_balance" position="before-user">
 *   Current balance: ${balance}
 * </Ephemeral>
 *
 * <Ephemeral type="tools" position="start" order={10}>
 *   Available tools: {toolList}
 * </Ephemeral>
 */
export function Ephemeral(props: EphemeralProps): JSX.Element {
  useDebugValue(`Ephemeral: ${props.type ?? "content"} @ ${props.position ?? "end"}`);
  return h("ephemeral", props);
}

// ============================================================================
// Grounding Component (Semantic wrapper for Ephemeral)
// ============================================================================

export interface GroundingProps extends EphemeralProps {
  /**
   * Optional title/heading for this grounding context.
   * Rendered as a header before the content.
   */
  title?: string;
  /**
   * Intended audience for this context.
   * @default 'model'
   */
  audience?: "model" | "user" | "both";
}

/**
 * Grounding component - semantic wrapper for Ephemeral.
 *
 * For dynamic state and world information that the model should be aware of.
 * This is ephemeral content (not persisted) that provides current context.
 *
 * Formatting (delimiters, etc.) is configured at the model level via
 * `modelOptions.messageTransformation`, not in JSX props.
 *
 * @example
 * // Basic usage with title
 * <Grounding title="Current State">
 *   Active todos: {JSON.stringify(todos)}
 * </Grounding>
 *
 * // Positioned before user's message
 * <Grounding title="User Preferences" position="before-user">
 *   Theme: dark, Language: en
 * </Grounding>
 *
 * // With type for semantic categorization
 * <Grounding type="system_state" audience="model">
 *   {stateJson}
 * </Grounding>
 */
export function Grounding(props: GroundingProps): JSX.Element {
  const {
    content,
    children,
    type,
    position = "start",
    order,
    audience = "model",
    title,
    id,
    tags,
    metadata,
  } = props;

  useDebugValue(`Grounding: ${title ?? type ?? "context"}`);

  return h(Ephemeral, {
    type,
    content,
    children,
    position,
    order,
    id,
    tags,
    metadata: {
      ...metadata,
      _grounding: {
        audience,
        title,
      },
    },
  });
}

// ============================================================================
// Exports
// ============================================================================

export { Message } from "./primitives.js";
