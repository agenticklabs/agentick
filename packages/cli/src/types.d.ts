/**
 * Type declarations for modules without types
 */

declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  interface MarkedTerminalOptions {
    code?: (code: string) => string;
    blockquote?: (quote: string) => string;
    html?: (html: string) => string;
    heading?: (text: string) => string;
    firstHeading?: (text: string) => string;
    hr?: () => string;
    listitem?: (text: string) => string;
    table?: (header: string, body: string) => string;
    paragraph?: (text: string) => string;
    strong?: (text: string) => string;
    em?: (text: string) => string;
    codespan?: (code: string) => string;
    del?: (text: string) => string;
    link?: (href: string, title: string | null, text: string) => string;
    href?: (href: string) => string;
    reflowText?: boolean;
    width?: number;
    showSectionPrefix?: boolean;
    unescape?: boolean;
    emoji?: boolean;
    tab?: number;
  }

  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
}
