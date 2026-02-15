/**
 * Characters that must be escaped in Telegram MarkdownV2.
 * @see https://core.telegram.org/bots/api#markdownv2-style
 */
const MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!]/g;

/**
 * Escape text for Telegram MarkdownV2 parse mode.
 *
 * All special characters are prefixed with a backslash.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL, "\\$&");
}
