/**
 * Markdown-to-terminal rendering via marked + marked-terminal.
 *
 * Returns ANSI-styled strings suitable for console.log output.
 * Width is computed at call time so the output adapts to terminal resizes.
 */

import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { theme } from "./theme.js";

/** Current terminal width, capped at 100 columns. */
export function getTerminalWidth(): number {
  return Math.min(process.stdout.columns ?? 80, 100);
}

let cachedWidth = 0;
let md: Marked;

function getMarked(): Marked {
  const width = getTerminalWidth();
  if (md && width === cachedWidth) return md;

  cachedWidth = width;
  md = new Marked(
    markedTerminal({
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
    }) as any,
  );
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
