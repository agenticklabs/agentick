/**
 * Event content-block contributors: user_action / system_event /
 * state_change.
 *
 * Valid inside `<message role="event">` per v1 grammar. Each carries
 * semantic fields plus optional `text` derived from JSX children (the
 * human-readable formatted representation).
 *
 * Props derive from each spec block type (minus the `type` discriminant);
 * every authored field — including the shared {@link BaseBlockKey} fields
 * — forwards by spread. `text` folds from children (overriding an authored
 * `text` prop only when children produce content). The per-block
 * {@link Exhausted} assertions fail `tsc` if a new spec field lands
 * unpartitioned.
 */

import type { StateChangeBlock, SystemEventBlock, UserActionBlock } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils";
import type { BaseBlockKey, Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

export type UserActionProps = Omit<UserActionBlock, "type">;
type _userActionConformance = Exhausted<
  UnhandledSpecKeys<
    UserActionBlock,
    BaseBlockKey | "action" | "actor" | "target" | "details",
    "type" | "text"
  >
>;

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
      ...(omitUndefined({ ...props }) as Partial<UserActionBlock>),
      type: "user_action",
      action: props.action,
      ...(childText.length > 0 ? { text: childText } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};

export type SystemEventProps = Omit<SystemEventBlock, "type">;
type _systemEventConformance = Exhausted<
  UnhandledSpecKeys<SystemEventBlock, BaseBlockKey | "event" | "source" | "data", "type" | "text">
>;

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
      ...(omitUndefined({ ...props }) as Partial<SystemEventBlock>),
      type: "system_event",
      event: props.event,
      ...(childText.length > 0 ? { text: childText } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};

export type StateChangeProps = Omit<StateChangeBlock, "type">;
type _stateChangeConformance = Exhausted<
  UnhandledSpecKeys<
    StateChangeBlock,
    BaseBlockKey | "entity" | "field" | "from" | "to" | "trigger",
    "type" | "text"
  >
>;

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
      ...(omitUndefined({ ...props }) as Partial<StateChangeBlock>),
      type: "state_change",
      entity: props.entity,
      from: props.from,
      to: props.to,
      ...(childText.length > 0 ? { text: childText } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};
