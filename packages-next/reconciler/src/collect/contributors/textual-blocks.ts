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
 */

import type {
  CodeBlock,
  CodeLanguage,
  CsvBlock,
  HtmlBlock,
  JsonBlock,
  ReasoningBlock,
  TextBlock,
  XmlBlock,
} from "@agentick/spec-next";
import type { ElementInstance } from "../../host/host-instance.js";
import type { CollectContext, Contributor } from "../contributor.js";
import type { IRFragment } from "../fragments.js";
import { omitUndefined } from "@agentick/utils-next";

interface TextBlockProps {
  readonly text?: string;
  readonly id?: string;
}

/**
 * `<text>` content-block — explicit text fragment. Useful when authors
 * want to attach an `id` to a text run, or when JSX context produces a
 * value via children that should be a discrete block.
 *
 * Bare strings inside section / message already produce text blocks via
 * the walker's text-instance handling — this contributor is for the
 * explicit `<text>...</text>` form.
 */
export const textBlockContributor: Contributor = {
  type: "text",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as TextBlockProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: TextBlock = {
      type: "text",
      text,
      ...omitUndefined({ id: props.id }),
    };
    return [{ kind: "content-block", block }];
  },
};

interface CodeProps {
  readonly text?: string;
  readonly language: CodeLanguage;
  readonly id?: string;
}

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
      type: "code",
      text,
      language: props.language,
      ...omitUndefined({ id: props.id }),
    };
    return [{ kind: "content-block", block }];
  },
};

interface JsonProps {
  readonly data?: unknown;
  readonly text?: string;
  readonly id?: string;
}

export const jsonContributor: Contributor = {
  type: "json",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as JsonProps;
    const childText = ctx.collectText(instance);
    const block: JsonBlock = {
      type: "json",
      ...omitUndefined({ data: props.data }),
      ...(props.text !== undefined
        ? { text: props.text }
        : childText.length > 0
          ? { text: childText }
          : {}),
      ...omitUndefined({ id: props.id }),
    };
    return [{ kind: "content-block", block }];
  },
};

interface XmlBlockProps {
  readonly text?: string;
  readonly id?: string;
}

export const xmlBlockContributor: Contributor = {
  type: "xml-block",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as XmlBlockProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: XmlBlock = {
      type: "xml",
      text,
      ...omitUndefined({ id: props.id }),
    };
    return [{ kind: "content-block", block }];
  },
};

interface CsvProps {
  readonly text?: string;
  readonly headers?: readonly string[];
  readonly id?: string;
}

export const csvContributor: Contributor = {
  type: "csv",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as CsvProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: CsvBlock = {
      type: "csv",
      text,
      ...omitUndefined({ headers: props.headers, id: props.id }),
    };
    return [{ kind: "content-block", block }];
  },
};

interface HtmlProps {
  readonly text?: string;
  readonly id?: string;
}

export const htmlContributor: Contributor = {
  type: "html",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as HtmlProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: HtmlBlock = {
      type: "html",
      text,
      ...omitUndefined({ id: props.id }),
    };
    return [{ kind: "content-block", block }];
  },
};

interface ReasoningProps {
  readonly text?: string;
  readonly signature?: string;
  readonly isRedacted?: boolean;
  readonly id?: string;
}

export const reasoningContributor: Contributor = {
  type: "reasoning",
  contribute(instance: ElementInstance, ctx: CollectContext): readonly IRFragment[] {
    const props = instance.props as unknown as ReasoningProps;
    const text = props.text ?? ctx.collectText(instance);
    const block: ReasoningBlock = {
      type: "reasoning",
      text,
      ...omitUndefined({ signature: props.signature, isRedacted: props.isRedacted, id: props.id }),
    };
    return [{ kind: "content-block", block }];
  },
};
