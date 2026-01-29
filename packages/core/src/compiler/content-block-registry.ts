import { type ContentBlock } from "@tentickle/shared";
import { Text, Image, Document, Audio, Video, Code, Json } from "../jsx/components/content";
import { H1, H2, H3, Header, Paragraph, Table, List } from "../jsx/components/semantic";
import { UserAction, SystemEvent, StateChange } from "../jsx/components/messages";
import { type JSX } from "../jsx/jsx-runtime";
import { type Formatter, type SemanticContentBlock } from "../renderers";
import {
  extractSemanticNodeFromElement,
  extractTextFromElement,
  extractTableStructure,
  extractListStructure,
} from "./extractors";

export type ContentBlockMapper = (
  element: JSX.Element,
  currentFormatter?: Formatter,
) => SemanticContentBlock | null;

/**
 * Initialize the content block mapper registry.
 * Maps JSX element types to their ContentBlock conversion functions.
 *
 * This can be called from the FiberCompiler constructor to set up the registry.
 */
export function initializeContentBlockMappers(
  register: (type: any, mapper: ContentBlockMapper, stringType?: string) => void,
): void {
  // Text block - children win over props (React convention)
  // Supports JSX children with inline formatting (bold, italic, code, etc.)
  register(
    Text,
    (el, currentFormatter) => {
      // If children exist, extract semantic node tree
      if (el.props.children !== undefined && el.props.children !== null) {
        const semanticNode = extractSemanticNodeFromElement(el, currentFormatter);
        // Attach renderer to semantic node for proper formatting later
        if (currentFormatter) {
          semanticNode.formatter = currentFormatter;
        }
        return {
          type: "text",
          text: "", // Will be populated by renderer from semanticNode
          semanticNode,
        };
      }
      // Fallback to text prop (plain text, no semantic structure)
      const text = el.props.text ?? "";
      return {
        type: "text",
        text,
        semanticNode: text ? { text } : undefined,
      };
    },
    "text",
  );

  // Native HTML block elements (work like Text but with semantic type marker)
  // <p> - paragraph
  register(
    "p" as any,
    (el, currentFormatter) => {
      const semanticNode = extractSemanticNodeFromElement(el, currentFormatter);
      // Attach renderer to semantic node for proper formatting later
      // This enables nested formatter boundaries (e.g., XML inside Section)
      if (currentFormatter) {
        semanticNode.formatter = currentFormatter;
      }
      return {
        type: "text",
        text: "",
        semanticNode,
        semantic: { type: "paragraph" },
      };
    },
    "p",
  );

  // <blockquote> - blockquote
  register(
    "blockquote" as any,
    (el, currentFormatter) => {
      const semanticNode = extractSemanticNodeFromElement(el, currentFormatter);
      // Attach renderer to semantic node for proper formatting later
      if (currentFormatter) {
        semanticNode.formatter = currentFormatter;
      }
      return {
        type: "text",
        text: "",
        semanticNode,
        semantic: { type: "blockquote" },
      };
    },
    "blockquote",
  );

  // Image block
  register(
    Image,
    (el) =>
      ({
        type: "image",
        source: el.props.source,
        mimeType: el.props.mimeType,
        altText: el.props.altText,
      }) as ContentBlock,
    "image",
  );

  // Document block
  register(
    Document,
    (el) =>
      ({
        type: "document",
        source: el.props.source,
        mimeType: el.props.mimeType,
        title: el.props.title,
      }) as ContentBlock,
    "document",
  );

  // Audio block
  register(
    Audio,
    (el) =>
      ({
        type: "audio",
        source: el.props.source,
        mimeType: el.props.mimeType,
        transcript: el.props.transcript,
      }) as ContentBlock,
    "audio",
  );

  // Video block
  register(
    Video,
    (el) =>
      ({
        type: "video",
        source: el.props.source,
        mimeType: el.props.mimeType,
        transcript: el.props.transcript,
      }) as ContentBlock,
    "video",
  );

  // Code block - children win over props (React convention)
  register(
    Code,
    (el) => {
      const childrenText =
        el.props.children !== undefined
          ? typeof el.props.children === "string"
            ? el.props.children
            : Array.isArray(el.props.children)
              ? el.props.children.join("")
              : ""
          : undefined;
      const text = childrenText ?? el.props.text ?? "";
      return {
        type: "code",
        language: el.props.language,
        text,
      } as ContentBlock;
    },
    "code",
  );

  // JSON block
  register(
    Json,
    (el) => {
      const jsonBlock: any = { type: "json" };
      if (el.props.data !== undefined) {
        jsonBlock.data = el.props.data;
      }
      if (el.props.text !== undefined) {
        jsonBlock.text = el.props.text;
      }
      return jsonBlock as SemanticContentBlock;
    },
    "json",
  );

  // Semantic primitives - Headings
  register(
    H1,
    (el, currentFormatter) => {
      const semanticNode = extractSemanticNodeFromElement(el, currentFormatter);
      if (currentFormatter) {
        semanticNode.formatter = currentFormatter;
      }
      return {
        type: "text",
        text: "", // Will be populated by renderer from semanticNode
        semanticNode,
        semantic: { type: "heading", level: 1 },
      } as SemanticContentBlock;
    },
    "h1",
  );

  register(
    H2,
    (el, currentFormatter) => {
      const semanticNode = extractSemanticNodeFromElement(el, currentFormatter);
      if (currentFormatter) {
        semanticNode.formatter = currentFormatter;
      }
      return {
        type: "text",
        text: "", // Will be populated by renderer from semanticNode
        semanticNode,
        semantic: { type: "heading", level: 2 },
      } as SemanticContentBlock;
    },
    "h2",
  );

  register(
    H3,
    (el, currentFormatter) => {
      const semanticNode = extractSemanticNodeFromElement(el, currentFormatter);
      if (currentFormatter) {
        semanticNode.formatter = currentFormatter;
      }
      return {
        type: "text",
        text: "", // Will be populated by renderer from semanticNode
        semanticNode,
        semantic: { type: "heading", level: 3 },
      } as SemanticContentBlock;
    },
    "h3",
  );

  register(
    Header,
    (el, currentFormatter) => {
      const level = el.props.level || 1;
      const semanticNode = extractSemanticNodeFromElement(el, currentFormatter);
      if (currentFormatter) {
        semanticNode.formatter = currentFormatter;
      }
      return {
        type: "text",
        text: "", // Will be populated by renderer from semanticNode
        semanticNode,
        semantic: { type: "heading", level },
      } as SemanticContentBlock;
    },
    "header",
  );

  // Paragraph
  register(
    Paragraph,
    (el, currentFormatter) => {
      const semanticNode = extractSemanticNodeFromElement(el, currentFormatter);
      if (currentFormatter) {
        semanticNode.formatter = currentFormatter;
      }
      return {
        type: "text",
        text: "", // Will be populated by renderer from semanticNode
        semanticNode,
        semantic: { type: "paragraph" },
      } as SemanticContentBlock;
    },
    "paragraph",
  );

  // Table
  register(
    Table,
    (el) => {
      const tableStructure = extractTableStructure(el);
      return {
        type: "text",
        text: "", // Renderer will build the text from structure
        semantic: {
          type: "table",
          structure: tableStructure,
        },
      } as SemanticContentBlock;
    },
    "table",
  );

  // List
  register(
    List,
    (el) => {
      const listStructure = extractListStructure(el);
      return {
        type: "text",
        text: "", // Renderer will build the text from structure
        semantic: {
          type: "list",
          structure: listStructure,
        },
      } as SemanticContentBlock;
    },
    "list",
  );

  // Note: Inline formatting elements (strong, em, code, etc.) are NOT registered here.
  // They are handled by INLINE_SEMANTIC_TYPES in extractors.ts and should only be used
  // nested inside text content blocks like <Text>, <p>, etc.
  // Using them at the top level (e.g., <Message><strong>text</strong></Message>) is incorrect.

  // Block elements
  // Note: 'p' and 'blockquote' are registered earlier with semantic tree support

  register(
    "ul",
    (el) => {
      const listStructure = extractListStructure(el);
      return {
        type: "text",
        text: "",
        semantic: {
          type: "list",
          structure: listStructure,
        },
      } as SemanticContentBlock;
    },
    "ul",
  );

  register(
    "ol",
    (el) => {
      const listStructure = extractListStructure(el);
      return {
        type: "text",
        text: "",
        semantic: {
          type: "list",
          structure: { ...listStructure, ordered: true },
        },
      } as SemanticContentBlock;
    },
    "ol",
  );

  register(
    "li",
    (el) => {
      // ListItem is handled by parent List/ul/ol
      const text = extractTextFromElement(el);
      return {
        type: "text",
        text,
        semantic: { type: "list-item" },
      } as SemanticContentBlock;
    },
    "li",
  );

  // Note: 'blockquote' is registered earlier with semantic tree support

  register(
    "pre",
    (el) => {
      const text = extractTextFromElement(el);
      return {
        type: "code",
        language: "other" as const,
        text,
      } as ContentBlock;
    },
    "pre",
  );

  register(
    "br",
    () => {
      return {
        type: "text",
        text: "\n",
        semantic: { type: "line-break" },
      } as SemanticContentBlock;
    },
    "br",
  );

  register(
    "hr",
    () => {
      return {
        type: "text",
        text: "---",
        semantic: { type: "horizontal-rule" },
      } as SemanticContentBlock;
    },
    "hr",
  );

  // Event block components
  register(
    UserAction,
    (el) => {
      const { action, actor, target, details, children } = el.props;
      const text = typeof children === "string" ? children : undefined;
      return {
        type: "user_action",
        action,
        actor,
        target,
        details,
        text,
      } as ContentBlock;
    },
    "user_action",
  );

  register(
    SystemEvent,
    (el) => {
      const { event, source, data, children } = el.props;
      const text = typeof children === "string" ? children : undefined;
      return {
        type: "system_event",
        event,
        source,
        data,
        text,
      } as ContentBlock;
    },
    "system_event",
  );

  register(
    StateChange,
    (el) => {
      const { entity, field, from, to, trigger, children } = el.props;
      const text = typeof children === "string" ? children : undefined;
      return {
        type: "state_change",
        entity,
        field,
        from,
        to,
        trigger,
        text,
      } as ContentBlock;
    },
    "state_change",
  );

  // Note: Other HTML elements (a, q, cite, kbd, var, etc.) are handled via
  // INLINE_SEMANTIC_TYPES when nested inside text content.
  // Custom/unknown elements are handled by the compiler's fallback mechanism.
}
