/**
 * Agentick v2 — naive coding agent, end to end.
 *
 * Stands up a gateway hosting a JSX coding agent (server.ts), connects a client
 * over an in-process transport (client.ts), and drives one coding request while
 * exercising the full v2 client ergonomics. The server and client are fully
 * decoupled — swapping the in-process transport for WebSocket/HTTP makes the
 * exact same client code drive a remote browser session.
 *
 * Run:
 *   1. cp .env.example .env   (fill in OPENAI_API_KEY)
 *   2. pnpm --filter example-v2-coding-agent dev
 */

import "dotenv/config";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import { startCodingServer } from "./server.js";
import { connectClient, runCodingSession } from "./client.js";

/** Seed a throwaway workspace so read/list/grep have something to chew on. */
async function makeScratchWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "coding-agent-"));
  await fs.writeFile(
    nodePath.join(dir, "greeting.js"),
    "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n",
    "utf8",
  );
  await fs.writeFile(
    nodePath.join(dir, "README.md"),
    "# scratch\n\nA throwaway workspace for the coding-agent example.\n",
    "utf8",
  );
  return dir;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const workspace = await makeScratchWorkspace();
  console.log(`workspace: ${workspace}`);

  const { gateway, appId } = await startCodingServer(workspace);
  const client = await connectClient(gateway);

  try {
    await runCodingSession(
      client,
      appId,
      "List the files, read greeting.js, then add a `farewell(name)` export to it. " +
        "Finally run `node -e \"import('./greeting.js').then(m => console.log(m.farewell('Ada')))\"` to prove it works.",
    );
  } finally {
    await client.close();
    await gateway.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("\nExample failed:", err);
  process.exit(1);
});
