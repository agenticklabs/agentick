/**
 * Custom content-block contributor.
 *
 * Application-defined tag, content, and attrs. Matches v1's
 * `CustomContentBlock` produced by `StreamTagParser` when the model's
 * text output contains application-defined inline tags. Authors can
 * also emit them directly as JSX.
 *
 * Props derive from {@link CustomContentBlock} (minus `type`); `content`
 * folds from children and `attrs` defaults to `{}` (both re-typed
 * OPTIONAL). Every other field — `tag`, `selfClosing`, and the shared
 * {@link BaseBlockKey} fields — forwards by spread, guarded by the
 * {@link _conformance} assertion.
 */

import type { CustomContentBlock } from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils-next";
import type { BaseBlockKey, Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/**
 * `<custom>` props, derived from {@link CustomContentBlock}. Deltas:
 * `content` re-typed OPTIONAL (folded from children when absent) and
 * `attrs` re-typed OPTIONAL (defaulted to `{}`).
 */
export type CustomProps = Omit<CustomContentBlock, "type" | "content" | "attrs"> & {
  readonly content?: string;
  readonly attrs?: Record<string, string>;
};

type CustomForwarded = BaseBlockKey | "tag" | "selfClosing";
type CustomSupplied = "type" | "content" | "attrs";
type _conformance = Exhausted<
  UnhandledSpecKeys<CustomContentBlock, CustomForwarded, CustomSupplied>
>;

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
      ...(omitUndefined({ ...props }) as Partial<CustomContentBlock>),
      type: "custom",
      tag: props.tag,
      content,
      attrs: props.attrs ?? {},
    };
    return [{ kind: "content-block", block }];
  },
};
