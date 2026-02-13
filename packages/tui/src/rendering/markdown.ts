/**
 * Markdown-to-terminal rendering via marked + marked-terminal.
 *
 * Returns ANSI-styled strings suitable for console.log output.
 * Width is computed at call time so the output adapts to terminal resizes.
 */

import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { theme } from "./theme.js";

/** Terminal width for rendering — text reflow, borders, separators. */
export function getTerminalWidth(): number {
  return process.stdout.columns ?? 80;
}

let cachedWidth = 0;
let md: Marked;

function getMarked(): Marked {
  const width = getTerminalWidth();
  if (md && width === cachedWidth) return md;

  cachedWidth = width;
  const ext = markedTerminal({
    firstHeading: theme.firstHeading,
    heading: theme.heading,
    strong: theme.strong,
    em: theme.em,
    codespan: theme.codespan,
    blockquote: theme.blockquote,
    hr: theme.hr,
    link: theme.link,
    href: theme.href,
    paragraph: (s: string) => s,

    showSectionPrefix: false,
    reflowText: true,
    width,
    tab: 2,
    emoji: false,
  }) as any;

  // marked-terminal bug: text renderer ignores inline tokens for tight list items.
  // When marked parses "1. **Bold:** desc" as a tight list, list item content arrives
  // as a { type: "text", text: "...", tokens: [...] } — the tokens array contains
  // parsed inline elements (strong, em, etc.) but the default text renderer discards
  // them and returns the raw string with literal ** markers. Fix: parse inline tokens.
  const originalText = ext.renderer.text;
  ext.renderer.text = function (this: any, token: any) {
    if (typeof token === "object" && token.tokens) {
      return this.parser.parseInline(token.tokens);
    }
    return originalText.call(this, token);
  };

  md = new Marked(ext);
  return md;
}

/**
 * Render a markdown string to ANSI-styled terminal output.
 * Strips the trailing newline that marked adds.
 */
export function renderMarkdown(text: string): string {
  const rendered = getMarked().parse(text) as string;
  return rendered.replace(/\n+$/, "");
}
