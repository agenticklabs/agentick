/**
 * Chat command - Interactive chat mode
 */

import { ChatSession } from "../chat-session.js";
import { loadConfig } from "../config.js";

interface ChatOptions {
  url?: string;
  session?: string;
  token?: string;
  stream?: boolean;
  debug?: boolean;
}

export async function chatCommand(options: ChatOptions): Promise<void> {
  // Load config with CLI overrides
  const config = loadConfig(options);

  if (!config.url) {
    console.error("Error: Server URL is required. Use --url or set TENTICKLE_URL.");
    process.exit(1);
  }

  const session = new ChatSession({
    url: config.url,
    sessionId: config.sessionId,
    token: config.token,
    streaming: options.stream !== false,
    debug: options.debug,
  });

  await session.start();
}
