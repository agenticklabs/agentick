/**
 * Formatter scope providers.
 *
 * `<FormatScope formatter={ref} purpose?={purpose}>{children}</FormatScope>`
 * pushes a new formatter binding into the `HostScope` for its
 * descendants. The collector's walker recognizes the underlying
 * `format` intrinsic and derives a new scope; the intrinsic itself
 * contributes no IR fragment.
 *
 * `<Markdown>` and `<XML>` are named convenience wrappers — they emit
 * the same primitive with a preset formatter id. Users adding their
 * own formatter conventions (`<JSON>`, `<Plain>`, ...) wrap
 * `<FormatScope>` the same way.
 *
 * Optional `purpose` prop scopes only one `FormatPurpose` slot — useful
 * when sections should render as markdown but free-root content as XML,
 * for example.
 *
 * The `format` intrinsic is INTERNAL — there is no JSX namespace
 * declaration for it (`<format />` is intentionally a TS error). All
 * authoring goes through `FormatScope` / `Markdown` / `XML` /
 * `PlainText`. v2's wider IntrinsicElements augmentation is deferred
 * to a later phase; see STATUS.md "Integration gaps" for the broader
 * intrinsic-typing story.
 *
 * @see docs/proposals/v2/blueprint/21-reconciler-implementation.md §Layer A (HostScope)
 */

import React, { type ReactNode } from "react";
import type { FormatPurpose, FormatterRef } from "@agentick/spec";

/**
 * Internal helper — emit a JSX intrinsic that v2 hasn't declared in the
 * global IntrinsicElements namespace. Centralizes the unavoidable type
 * cast so individual call sites stay readable.
 */
function internalIntrinsic(
  type: string,
  props: Readonly<Record<string, unknown>>,
  children?: ReactNode,
): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement(type as any, props, children);
}

export interface FormatScopeProps {
  /**
   * The formatter to bind in the new scope. Required.
   */
  readonly formatter: FormatterRef;
  /**
   * When set, scope only this purpose. Otherwise the formatter
   * replaces the scope's default for descendants.
   */
  readonly purpose?: FormatPurpose;
  readonly children?: ReactNode;
}

/**
 * Canonical formatter-scope primitive. Render with the formatter you
 * want descendants to use.
 */
export function FormatScope({
  formatter,
  purpose,
  children,
}: FormatScopeProps): React.ReactElement {
  return internalIntrinsic("format", purpose ? { formatter, purpose } : { formatter }, children);
}

export interface NamedFormatScopeProps {
  readonly purpose?: FormatPurpose;
  readonly children?: ReactNode;
}

/**
 * `<Markdown>` — sugar for `<FormatScope formatter={{ id: "markdown", format: "markdown" }}>`.
 * Descendants render as markdown.
 */
export function Markdown({ purpose, children }: NamedFormatScopeProps): React.ReactElement {
  return React.createElement(
    FormatScope,
    { formatter: { id: "markdown", format: "markdown" }, purpose },
    children,
  );
}

/**
 * `<XML>` — sugar for `<FormatScope formatter={{ id: "xml", format: "xml" }}>`.
 * Descendants render as XML.
 */
export function XML({ purpose, children }: NamedFormatScopeProps): React.ReactElement {
  return React.createElement(
    FormatScope,
    { formatter: { id: "xml", format: "xml" }, purpose },
    children,
  );
}

/**
 * `<Text>` (formatter scope, NOT content block) — sugar for
 * `<FormatScope formatter={{ id: "text", format: "text" }}>`. Descendants
 * render as plain text (no markdown/XML decoration).
 *
 * Named to avoid collision with a future `<text>` content-block intrinsic
 * — convention: scope providers are PascalCase, content blocks lowercase.
 */
export function PlainText({ purpose, children }: NamedFormatScopeProps): React.ReactElement {
  return React.createElement(
    FormatScope,
    { formatter: { id: "text", format: "text" }, purpose },
    children,
  );
}
