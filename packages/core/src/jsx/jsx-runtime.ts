import React from "react";
import type z from "zod";
import type { ComponentClass, ComponentFactory } from "../component/component.js";
import type { ToolClass, ExecutableTool } from "../tool/tool.js";
import type { ContentBlock, MessageRoles, ToolExecutionType, SectionInput } from "@agentick/shared";

// Use React's createElement for all element creation
// This ensures elements have proper $$typeof symbol
const h = React.createElement;

export namespace JSX {
  export interface Element {
    type: any;
    props: any;
    key: string | null;
  }

  /**
   * Allow function components to return Promise<Element> for async components.
   * This is valid in Agentick because we don't have UI rendering constraints.
   */
  export interface ElementChildrenAttribute {
    children: {};
  }

  /**
   * Attributes available on all JSX elements (intrinsic and components).
   * Mirrors React's IntrinsicAttributes — provides `key` without each element declaring it.
   */
  export interface IntrinsicAttributes {
    key?: string | number | null;
  }

  /**
   * Tell TypeScript that async functions returning Promise<Element> are valid components.
   */
  export type LibraryManagedAttributes<_C, P> = P;

  /**
   * Allow async components by accepting Promise<Element> as a valid element type.
   */
  export type ElementType =
    | keyof IntrinsicElements
    | ((props: any) => Element | null | Promise<Element | null>)
    | { new (props: any): any };

  /**
   * Base props shared by all intrinsic elements.
   * Includes `key` explicitly because TypeScript's jsxImportSource mode
   * doesn't reliably merge IntrinsicAttributes into named element types.
   */
  interface BaseProps {
    key?: string | number | null;
    children?: any;
  }

  export interface IntrinsicElements {
    section: SectionInput &
      BaseProps & {
        /**
         * Section content - can be any type, or use children for ContentBlocks.
         * If children are provided, content prop is ignored.
         */
        content?: any;
      };
    timeline: BaseProps & {
      /**
       * Timeline wrapper component.
       * Children are Message components that will be added to the timeline.
       */
    };
    message: BaseProps & {
      /**
       * Message ID - used for merging/overwriting messages.
       */
      id?: string;
      /**
       * Message role - maintains model semantics for user intuition.
       * This is the intuitive API even though internally it becomes a COMTimelineEntry.
       */
      role: MessageRoles;
      /**
       * Message content - can be string (normalized to ContentBlock[]) or ContentBlock[].
       * If children are provided, this is ignored.
       */
      content?: string | ContentBlock[];
      /**
       * Optional tags for filtering/categorization.
       */
      tags?: string[];
      /**
       * Visibility level.
       */
      visibility?: "model" | "observer" | "log";
      /**
       * Additional metadata.
       */
      metadata?: Record<string, unknown>;
    };
    /**
     * @internal Intrinsic element for tool registration. Created by ToolComponent, not user-facing.
     * Use `<MyTool />` (from createTool) instead of raw `<tool>` elements.
     */
    tool: BaseProps & {
      definition?: ToolClass | ExecutableTool | string;
      name?: string;
      description?: string;
      input?: z.ZodSchema;
      schema?: unknown;
      executionType?: ToolExecutionType;
      handler?: (input: any, ctx?: any) => Promise<ContentBlock[]>;
      metadata?: import("../tool/tool.js").ToolMetadata;
    };
    // Content block primitives
    text: BaseProps & {
      text?: string;
    };
    image: BaseProps & {
      source: any; // MediaSource
      mimeType?: string;
      altText?: string;
    };
    document: BaseProps & {
      source: any; // MediaSource
      mimeType?: string;
      title?: string;
    };
    // Note: audio and video are defined below as native HTML elements
    // Use capitalized components (Audio, Video) for structural content blocks
    // Note: Use <Code> component for structural code blocks, <code> for inline code
    fragment: BaseProps;
    // Renderer components
    markdown: BaseProps & {
      flavor?: "github" | "commonmark" | "gfm";
    };
    // Semantic primitives
    h1: BaseProps;
    h2: BaseProps;
    h3: BaseProps;
    header: BaseProps & { level?: 1 | 2 | 3 | 4 | 5 | 6 };
    paragraph: BaseProps;
    list: BaseProps & { ordered?: boolean };
    listitem: BaseProps;
    table: BaseProps;
    row: BaseProps & { header?: boolean };
    column: BaseProps;
    // Inline formatting elements
    strong: BaseProps;
    b: BaseProps;
    em: BaseProps;
    i: BaseProps;
    inlineCode: BaseProps;
    code: BaseProps;
    mark: BaseProps;
    u: BaseProps;
    s: BaseProps;
    del: BaseProps;
    sub: BaseProps;
    sup: BaseProps;
    small: BaseProps;
    // Native HTML media elements (semantic - converted to inline markdown when nested in text)
    img: BaseProps & { src?: string; alt?: string };
    audio: BaseProps & { src?: string };
    video: BaseProps & { src?: string; controls?: boolean };
    // Block elements
    p: BaseProps;
    ul: BaseProps;
    ol: BaseProps;
    li: BaseProps;
    blockquote: BaseProps;
    pre: BaseProps;
    br: BaseProps;
    hr: BaseProps;
    // Other useful elements
    a: BaseProps & { href?: string };
    q: BaseProps;
    cite: BaseProps;
    kbd: BaseProps;
    var: BaseProps;
    // Catch-all for custom XML tags
    // Allows any lowercase tag (e.g., <customTag>, <equation>, <metric>)
    [tagName: string]: BaseProps & { [prop: string]: any };
  }
}

/**
 * Accept any class constructor that could be a component.
 * This is more flexible than requiring ComponentClass from component.ts
 * to support classes that implement Component directly.
 */
type _AnyComponentClass = new (...args: any[]) => any;

/**
 * Function component type - functions that take props and return JSX.Element
 */
type FunctionComponent<P = any> = (props: P) => JSX.Element | null;

/**
 * Extract props type from function component.
 */
type FunctionComponentProps<T> = (T extends (props: infer P) => any ? P : never) & {
  ref?: string;
  key?: string | number | null;
  children?: any;
};

/**
 * Extract props type from Component<P> class.
 * Components that extend Component<P> have their props type as the first generic parameter.
 */
type ExtractComponentProps<T> = (T extends { props: infer P } ? P : never) & {
  ref?: string;
  key?: string | number | null;
  children?: any;
};

/**
 * jsx() function for React 17+ JSX transform compatibility.
 * Used when jsx: "react-jsx" mode is enabled in tsconfig.
 */
// Overload 1: Component classes that extend Component<P>
// Extract props type from Component<P> generic parameter
export function jsx<T extends new (...args: any[]) => { props: any }>(
  type: T,
  props: ExtractComponentProps<InstanceType<T>>,
  key?: string | number | null,
): JSX.Element;
// Overload 1b: Other component classes (fallback for classes without explicit props)
export function jsx<T extends new (...args: any[]) => any>(
  type: T,
  props: any,
  key?: string | number | null,
): JSX.Element;
// Overload 2: Function components
export function jsx<T extends FunctionComponent<any>>(
  type: T,
  props: FunctionComponentProps<T>,
  key?: string | number | null,
): JSX.Element;
// Overload 3: ComponentClass (from component.ts) - more specific than AnyComponentClass
// Only matches classes that extend EngineComponent
// IMPORTANT: This must NOT match FormattedTextBlock - it requires EngineComponent return type
export function jsx(type: ComponentClass, props: any, key?: string | number | null): JSX.Element;
// Overload 4: ComponentFactory
export function jsx(type: ComponentFactory, props: any, key?: string | number | null): JSX.Element;
// Overload 5: Already a JSX.Element
export function jsx(type: JSX.Element, props: any, key?: string | number | null): JSX.Element;
// Overload 6: Intrinsic elements
export function jsx<K extends keyof JSX.IntrinsicElements>(
  type: K,
  props: JSX.IntrinsicElements[K],
  key?: string | number | null,
): JSX.Element;
// Implementation
export function jsx(type: any, props: any, key?: string | number | null): JSX.Element {
  // If type is already a React element, return it
  if (React.isValidElement(type)) {
    return type as unknown as JSX.Element;
  }
  // Use React.createElement to create proper React elements with $$typeof
  const { children, ...restProps } = props || {};
  const reactKey = key ?? props?.key ?? null;
  // React.createElement handles children properly
  const element =
    children !== undefined
      ? h(type, { ...restProps, key: reactKey }, children)
      : h(type, { ...restProps, key: reactKey });
  return element as unknown as JSX.Element;
}

/**
 * jsxs() function for React 17+ JSX transform compatibility (for multiple children).
 * Used when jsx: "react-jsx" mode is enabled in tsconfig.
 */
// Overload 1: Component classes that extend Component<P>
export function jsxs<T extends new (...args: any[]) => { props: any }>(
  type: T,
  props: ExtractComponentProps<InstanceType<T>> & {
    ref?: string;
    key?: string | number | null;
    children?: any;
  },
  key?: string | number | null,
): JSX.Element;
// Overload 1b: Other component classes (fallback)
export function jsxs<T extends new (...args: any[]) => any>(
  type: T,
  props: any,
  key?: string | number | null,
): JSX.Element;
// Overload 2: Function components
export function jsxs<T extends FunctionComponent<any>>(
  type: T,
  props: FunctionComponentProps<T>,
  key?: string | number | null,
): JSX.Element;
// Overload 3: ComponentClass (from component.ts)
export function jsxs(type: ComponentClass, props: any, key?: string | number | null): JSX.Element;
// Overload 4: ComponentFactory
export function jsxs(type: ComponentFactory, props: any, key?: string | number | null): JSX.Element;
// Overload 5: Already a JSX.Element
export function jsxs(type: JSX.Element, props: any, key?: string | number | null): JSX.Element;
// Overload 6: Intrinsic elements
export function jsxs<K extends keyof JSX.IntrinsicElements>(
  type: K,
  props: JSX.IntrinsicElements[K],
  key?: string | number | null,
): JSX.Element;
// Implementation
export function jsxs(type: any, props: any, key?: string | number | null): JSX.Element {
  return jsx(type, props, key);
}

/**
 * jsxDEV() function for React 17+ JSX transform in development mode.
 * Has additional parameters for debugging (source location, etc.)
 */
// Overload 1: Component classes that extend Component<P>
export function jsxDEV<T extends new (...args: any[]) => { props: any }>(
  type: T,
  props: ExtractComponentProps<InstanceType<T>>,
  key?: string | number | null,
  _isStaticChildren?: boolean,
  _source?: { fileName: string; lineNumber: number; columnNumber: number },
  _self?: any,
): JSX.Element;
// Overload 1b: Other component classes (fallback)
export function jsxDEV<T extends new (...args: any[]) => any>(
  type: T,
  props: any,
  key?: string | number | null,
  _isStaticChildren?: boolean,
  _source?: { fileName: string; lineNumber: number; columnNumber: number },
  _self?: any,
): JSX.Element;
// Overload 2: Function components
export function jsxDEV<T extends FunctionComponent<any>>(
  type: T,
  props: FunctionComponentProps<T>,
  key?: string | number | null,
  _isStaticChildren?: boolean,
  _source?: { fileName: string; lineNumber: number; columnNumber: number },
  _self?: any,
): JSX.Element;
// Overload 3: ComponentClass (from component.ts)
export function jsxDEV(
  type: ComponentClass,
  props: any,
  key?: string | number | null,
  _isStaticChildren?: boolean,
  _source?: { fileName: string; lineNumber: number; columnNumber: number },
  _self?: any,
): JSX.Element;
// Overload 4: ComponentFactory
export function jsxDEV(
  type: ComponentFactory,
  props: any,
  key?: string | number | null,
  _isStaticChildren?: boolean,
  _source?: { fileName: string; lineNumber: number; columnNumber: number },
  _self?: any,
): JSX.Element;
// Overload 5: Already a JSX.Element
export function jsxDEV(
  type: JSX.Element,
  props: any,
  key?: string | number | null,
  _isStaticChildren?: boolean,
  _source?: { fileName: string; lineNumber: number; columnNumber: number },
  _self?: any,
): JSX.Element;
// Overload 6: Intrinsic elements
export function jsxDEV<K extends keyof JSX.IntrinsicElements>(
  type: K,
  props: JSX.IntrinsicElements[K],
  key?: string | number | null,
  _isStaticChildren?: boolean,
  _source?: { fileName: string; lineNumber: number; columnNumber: number },
  _self?: any,
): JSX.Element;
// Implementation
export function jsxDEV(
  type: any,
  props: any,
  key?: string | number | null,
  _isStaticChildren?: boolean,
  _source?: { fileName: string; lineNumber: number; columnNumber: number },
  _self?: any,
): JSX.Element {
  return jsx(type, props, key);
}

/**
 * createElement() function for legacy JSX transform or explicit usage.
 */
// Overload 1: Already a JSX.Element (instance)
export function createElement(type: JSX.Element, props: any, ...children: any[]): JSX.Element;
// Overload 2: Component classes that extend Component<P>
export function createElement<T extends new (...args: any[]) => { props: any }>(
  type: T,
  props: ExtractComponentProps<InstanceType<T>>,
  ...children: any[]
): JSX.Element;
// Overload 2b: Other component classes (fallback)
export function createElement<T extends new (...args: any[]) => any>(
  type: T,
  props: any,
  ...children: any[]
): JSX.Element;
// Overload 3: ComponentClass (from component.ts - returns EngineComponent)
export function createElement(type: ComponentClass, props: any, ...children: any[]): JSX.Element;
// Overload 4: Function components (relaxed constraint)
export function createElement<T extends (props: any) => any>(
  type: T,
  props: any,
  ...children: any[]
): JSX.Element;
// Overload 5: ComponentFactory (returns Component, not JSX.Element)
export function createElement(type: ComponentFactory, props: any, ...children: any[]): JSX.Element;
// Overload 6: Intrinsic elements (must be last)
export function createElement<K extends keyof JSX.IntrinsicElements>(
  type: K,
  props: JSX.IntrinsicElements[K],
  ...children: any[]
): JSX.Element;
// Implementation
export function createElement(type: any, props: any, ...children: any[]): JSX.Element {
  // If type is already a React element, return it (ignore props/children)
  if (React.isValidElement(type)) {
    return type as unknown as JSX.Element;
  }
  // Use React.createElement to create proper React elements with $$typeof
  const element = h(type, props, ...children);
  return element as unknown as JSX.Element;
}

// Use React.Fragment for proper fragment support
export const Fragment = React.Fragment;

export function isElement(node: any): node is JSX.Element {
  return React.isValidElement(node);
}

export function ensureElement(element: any, props: any = {}, children: any[] = []): JSX.Element {
  if (element !== undefined) {
    if (React.isValidElement(element)) {
      // Already a React element
      return element as unknown as JSX.Element;
    } else if (Array.isArray(element)) {
      // Array of ComponentDefinitions
      const mappedChildren = element.map((c) => {
        if (React.isValidElement(c)) {
          return c;
        }
        // ComponentDefinition can be instance, class, factory, or function
        // createElement handles classes/functions, but instances need special handling
        // If it's an instance (object with render but not a function), wrap it
        if (
          c &&
          typeof c === "object" &&
          "render" in c &&
          typeof (c as any).constructor === "function"
        ) {
          // It's an instance - use its constructor
          return createElement((c as any).constructor, {});
        }
        // Otherwise pass through - createElement will handle it
        return createElement(c as any, {});
      });
      return createElement(Fragment, {}, ...mappedChildren);
    } else {
      // Single ComponentDefinition
      return React.isValidElement(element)
        ? (element as unknown as JSX.Element)
        : createElement(element, props, ...children);
    }
  }

  return createElement(Fragment, {});
}
