/**
 * Status command - Show server and session status
 */

import { Renderer } from "../ui/renderer.js";
import { loadConfig } from "../config.js";

interface StatusOptions {
  url?: string;
  session?: string;
  token?: string;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const config = loadConfig(options);
  const renderer = new Renderer();

  if (!config.url) {
    console.error("Error: Server URL is required. Use --url or set TENTICKLE_URL.");
    process.exit(1);
  }

  renderer.info("\nTentickle Status");
  renderer.separator();
  renderer.info(`URL: ${config.url}`);
  renderer.info(`Session: ${config.sessionId ?? "(auto-create)"}`);
  renderer.info(`Token: ${config.token ? "(set)" : "(not set)"}`);
  renderer.separator();

  renderer.info("\nNote: Server status check not yet implemented.");
  renderer.info("Use 'tentickle chat' to connect and '/status' for session info.\n");
}
