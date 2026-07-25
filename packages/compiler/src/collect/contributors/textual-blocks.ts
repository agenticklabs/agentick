/**
 * Textual content-block contributors: code / json / reasoning / xml /
 * csv / html / text.
 *
 * Most fold their text children into the block's `text` prop (so authors
 * can write `<code language="ts">{snippet}</code>` instead of
 * `<code text={snippet} language="ts"/>`). Explicit `text` prop wins
 * over child text when both are present.
 *
 * `<json>` takes a `data` prop directly (JSON-shaped values). Its
 * children fold into a stringified pretty-print fallback when no
 * `data` prop is given — useful for visualizing pre-stringified JSON.
 *
 * Props derive from each spec block type (minus the `type` discriminant);
 * every authored field — including the shared {@link BaseBlockKey} fields
 * — forwards by spread. The per-block {@link Exhausted} assertions fail
 * `tsc` if a new spec field is added without being partitioned.
 */

import type {
  CodeBlock,
  CsvBlock,
  HtmlBlock,
  JsonBlock,
  ReasoningBlock,
  TextBlock,
  XmlBlock,
} from "@agentick/spec";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils";
import type { BaseBlockKey, Exhausted, UnhandledSpecKeys } from "./spec-conformance.js";

/**
 * `<text>` content-block — explicit text fragment. Useful when authors
 * want to attach an `id` to a text run, or when JSX context produces a
 * value via children that should be a discrete block.
 *
 * Bare strings inside section / message already produce text blocks via
 * the walker's text-instance handling — this contributor is for the
 * explicit `<text>...</text>` form.
 */
export type TextBlockProps = Omit<TextBlock, "type">;
type _textConformance = Exhausted<UnhandledSpecKeys<TextBlock, BaseBlockKey, "type" | "text">>;

export const textBlockContributor: Contributor = {
  type: "text",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as TextBlockProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: TextBlock = {
      ...(omitUndefined({ ...props }) as Partial<TextBlock>),
      type: "text",
      text,
    };
    return [{ kind: "content-block", block }];
  },
};

export type CodeProps = Omit<CodeBlock, "type">;
type _codeConformance = Exhausted<
  UnhandledSpecKeys<CodeBlock, BaseBlockKey | "language", "type" | "text">
>;

export const codeContributor: Contributor = {
  type: "code",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as CodeProps;
    if (!props.language) {
      return [
        {
          kind: "diagnostic",
          diagnostic: {
            severity: "warning",
            code: "MISSING_LANGUAGE",
            message: `<code> requires a "language" prop`,
          },
        },
      ];
    }
    const text = props.text ?? ctx.collectText(instance);
    const block: CodeBlock = {
      ...(omitUndefined({ ...props }) as Partial<CodeBlock>),
      type: "code",
      text,
      language: props.language,
    };
    return [{ kind: "content-block", block }];
  },
};

export type JsonProps = Omit<JsonBlock, "type">;
type _jsonConformance = Exhausted<
  UnhandledSpecKeys<JsonBlock, BaseBlockKey | "data", "type" | "text">
>;

export const jsonContributor: Contributor = {
  type: "json",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as JsonProps;
    const childText = ctx.collectText(instance);
    const block: JsonBlock = {
      ...(omitUndefined({ ...props }) as Partial<JsonBlock>),
      type: "json",
      ...(props.text !== undefined
        ? { text: props.text }
        : childText.length > 0
          ? { text: childText }
          : {}),
    };
    return [{ kind: "content-block", block }];
  },
};

export type XmlBlockProps = Omit<XmlBlock, "type">;
type _xmlConformance = Exhausted<UnhandledSpecKeys<XmlBlock, BaseBlockKey, "type" | "text">>;

export const xmlBlockContributor: Contributor = {
  type: "xml-block",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as XmlBlockProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: XmlBlock = {
      ...(omitUndefined({ ...props }) as Partial<XmlBlock>),
      type: "xml",
      text,
    };
    return [{ kind: "content-block", block }];
  },
};

export type CsvProps = Omit<CsvBlock, "type">;
type _csvConformance = Exhausted<
  UnhandledSpecKeys<CsvBlock, BaseBlockKey | "headers", "type" | "text">
>;

export const csvContributor: Contributor = {
  type: "csv",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as CsvProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: CsvBlock = {
      ...(omitUndefined({ ...props }) as Partial<CsvBlock>),
      type: "csv",
      text,
    };
    return [{ kind: "content-block", block }];
  },
};

export type HtmlProps = Omit<HtmlBlock, "type">;
type _htmlConformance = Exhausted<UnhandledSpecKeys<HtmlBlock, BaseBlockKey, "type" | "text">>;

export const htmlContributor: Contributor = {
  type: "html",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as HtmlProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: HtmlBlock = {
      ...(omitUndefined({ ...props }) as Partial<HtmlBlock>),
      type: "html",
      text,
    };
    return [{ kind: "content-block", block }];
  },
};

export type ReasoningProps = Omit<ReasoningBlock, "type">;
type _reasoningConformance = Exhausted<
  UnhandledSpecKeys<ReasoningBlock, BaseBlockKey | "signature" | "isRedacted", "type" | "text">
>;

export const reasoningContributor: Contributor = {
  type: "reasoning",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ReasoningProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: ReasoningBlock = {
      ...(omitUndefined({ ...props }) as Partial<ReasoningBlock>),
      type: "reasoning",
      text,
    };
    return [{ kind: "content-block", block }];
  },
};
