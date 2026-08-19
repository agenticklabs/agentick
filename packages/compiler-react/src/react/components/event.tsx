/**
 * Event components — the PascalCase door to the event blocks.
 *
 * `<SystemEvent>` / `<UserAction>` / `<StateChange>` are position-aware
 * (via {@link MessageScopeContext}): at the top level each forms its own
 * event-role entry (`<Event>` wrapping the block); inside any message it
 * contributes just the block. Both positions produce what the author meant,
 * so one component serves both without a nested-entry hazard:
 *
 * ```tsx
 * <SystemEvent event="compaction" source="timeline" data={{ summary }} />
 *
 * <Event>
 *   <system_event event="job-sync" source="scheduler" />
 *   <state_change entity="job-113" field="status" from="draft" to="active" />
 * </Event>
 * ```
 *
 * Each lowers 1:1 to its underscored intrinsic — the wire record that
 * persists in the timeline (the formatter derives the text; see
 * `packages/compiler/src/collect/contributors/event-blocks.ts`).
 */

import React from "react";
import { Message, MessageScopeContext } from "./message.js";

interface EventBlockBaseProps {
  readonly id?: string;
  readonly text?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SystemEventProps extends EventBlockBaseProps {
  readonly event: string;
  readonly source?: string;
  readonly data?: Record<string, unknown>;
}

export interface UserActionProps extends EventBlockBaseProps {
  readonly action: string;
  readonly actor?: string;
  readonly target?: string;
  readonly details?: Record<string, unknown>;
}

export interface StateChangeProps extends EventBlockBaseProps {
  readonly entity: string;
  readonly field?: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly trigger?: string;
}

function positionAware<P extends object>(intrinsic: string) {
  return function EventComponent(props: P): React.ReactElement {
    const insideMessage = React.useContext(MessageScopeContext);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = React.createElement(intrinsic as any, props);
    return insideMessage ? block : React.createElement(Message, { role: "event" }, block);
  };
}

/** A system event — its own event entry at top level, a block inside one. */
export const SystemEvent = positionAware<SystemEventProps>("system_event");

/** A user action record — entry at top level, block inside a message. */
export const UserAction = positionAware<UserActionProps>("user_action");

/** A state transition record — entry at top level, block inside a message. */
export const StateChange = positionAware<StateChangeProps>("state_change");
