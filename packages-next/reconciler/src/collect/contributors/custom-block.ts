/**
 * Custom content-block contributor.
 *
 * Application-defined tag, content, and attrs. Matches v1's
 * `CustomContentBlock` produced by `StreamTagParser` when the model's
 * text output contains application-defined inline tags. Authors can
 * also emit them directly as JSX.
 */

import type { CustomContentBlock } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";

interface CustomProps {
  readonly tag: string;
  readonly content?: string;
  readonly attrs?: Record<string, string>;
  readonly selfClosing?: boolean;
  readonly id?: string;
}

export const customBlockContributor: Contributor = {
  type: "custom",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as CustomProps;
    if (!props.tag) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            code: "MISSING_TAG",
            message: `<custom> requires a "tag" prop`,
          },
        },
      ];
    }
    const content = props.content ?? ctx.collectText(instance);
    const block: CustomContentBlock = {
      type: "custom",
      tag: props.tag,
      content,
      attrs: props.attrs ?? {},
      ...(props.selfClosing !== undefined ? { selfClosing: props.selfClosing } : {}),
      ...(props.id !== undefined ? { id: props.id } : {}),
    };
    return [{ kind: "content-block", block }];
  },
};
