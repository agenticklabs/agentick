/**
 * Event content-block contributors: user_action / system_event /
 * state_change.
 *
 * Valid inside `<message role="event">` per v1 grammar. Each carries
 * semantic fields plus optional `text` derived from JSX children (the
 * human-readable formatted representation).
 */

import type { StateChangeBlock, SystemEventBlock, UserActionBlock } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface UserActionProps {
  readonly action: string;
  readonly actor?: string;
  readonly target?: string;
  readonly details?: Record<string, unknown>;
  readonly id?: string;
}

export const userActionContributor: Contributor = {
  type: "user_action",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as UserActionProps;
    if (!props.action) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            code: "MISSING_ACTION",
            message: `<user_action> requires an "action" prop`,
          },
        },
      ];
    }
    const childText = ctx.collectText(instance);
    const block: UserActionBlock = {
      type: "user_action",
      action: props.action,
      ...(props.actor !== undefined ? { actor: props.actor } : {}),
      ...(props.target !== undefined ? { target: props.target } : {}),
      ...(props.details !== undefined ? { details: props.details } : {}),
      ...(childText.length > 0 ? { text: childText } : {}),
      ...(props.id !== undefined ? { id: props.id } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};

interface SystemEventProps {
  readonly event: string;
  readonly source?: string;
  readonly data?: Record<string, unknown>;
  readonly id?: string;
}

export const systemEventContributor: Contributor = {
  type: "system_event",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as SystemEventProps;
    if (!props.event) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            code: "MISSING_EVENT",
            message: `<system_event> requires an "event" prop`,
          },
        },
      ];
    }
    const childText = ctx.collectText(instance);
    const block: SystemEventBlock = {
      type: "system_event",
      event: props.event,
      ...(props.source !== undefined ? { source: props.source } : {}),
      ...(props.data !== undefined ? { data: props.data } : {}),
      ...(childText.length > 0 ? { text: childText } : {}),
      ...(props.id !== undefined ? { id: props.id } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};

interface StateChangeProps {
  readonly entity: string;
  readonly field?: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly trigger?: string;
  readonly id?: string;
}

export const stateChangeContributor: Contributor = {
  type: "state_change",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as StateChangeProps;
    if (!props.entity) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            code: "MISSING_ENTITY",
            message: `<state_change> requires an "entity" prop`,
          },
        },
      ];
    }
    const childText = ctx.collectText(instance);
    const block: StateChangeBlock = {
      type: "state_change",
      entity: props.entity,
      from: props.from,
      to: props.to,
      ...(props.field !== undefined ? { field: props.field } : {}),
      ...(props.trigger !== undefined ? { trigger: props.trigger } : {}),
      ...(childText.length > 0 ? { text: childText } : {}),
      ...(props.id !== undefined ? { id: props.id } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};
