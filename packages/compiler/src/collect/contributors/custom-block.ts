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

import type { CustomContentBlock } from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils";
import { isTextInstance } from "../../host/host-instance.js";
import { collectSemanticChildren } from "./semantic-html.js";
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

/**
 * The custom-elements rule, imported from the web platform: a lowercase
 * intrinsic containing a hyphen is an application-defined tag, forever
 * collision-free with framework intrinsics (which are single words or
 * registered explicitly). `<relevant-context source="rag">` is sugar for
 * `<custom tag="relevant-context" attrs={{source: "rag"}}>`.
 */
export function isCustomTagType(type: unknown): type is string {
  return typeof type === "string" && type.includes("-");
}

/** Re-shape a hyphenated intrinsic as the `<custom>` contributor's input. */
export function asCustomTagInstance(instance: ElementInstance): ElementInstance {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(instance.props)) {
    if (key === "children" || key === "key") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attrs[key] = String(value);
    }
  }
  return {
    ...instance,
    props: { tag: instance.type as string, attrs },
  };
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
    // Element children mean structure, and structure has to survive: collapsing
    // them with `collectText` is what flattened a nested custom to bare words.
    // The node form nests; the block form is the leaf.
    if (props.content === undefined && instance.children.some((c) => !isTextInstance(c))) {
      return [
        {
          kind: "semantic-node",
          node: {
            semantic: "custom",
            props: omitUndefined({
              tag: props.tag,
              attrs: props.attrs,
              selfClosing: props.selfClosing,
            }),
            children: collectSemanticChildren(instance, ctx),
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
