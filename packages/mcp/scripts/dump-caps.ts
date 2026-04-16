/**
 * Wire-level sanity check for MCP Apps capability negotiation.
 *
 * Spins up an MCPServer with one app, connects an SDK Client via
 * InMemoryTransport, and dumps the initialize response's server capabilities
 * + tools/list + resources/list so we can see exactly what Claude Desktop
 * (or any conformant host) would receive.
 *
 * Run from packages/mcp:  pnpm tsx scripts/dump-caps.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "../src/transport/index.js";
import { MCPServer } from "../src/server/server.js";

async function main() {
  const server = new MCPServer({
    name: "demo",
    version: "1.0.0",
    tools: [
      {
        name: "show_dashboard",
        description: "Open the dashboard UI",
        inputSchema: { type: "object" },
        ui: { resourceUri: "ui://demo/dashboard", visibility: ["model", "app"] },
        handler: async () => ({
          content: [{ type: "text", text: "dashboard rendered" }],
        }),
      },
    ],
    apps: [
      {
        name: "dashboard",
        uri: "ui://demo/dashboard",
        description: "Demo dashboard",
        content: "<!DOCTYPE html><html><body><h1>hi</h1></body></html>",
        csp: { resourceDomains: ["https://cdn.example.com"] },
        prefersBorder: true,
      },
    ],
  });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "demo-client", version: "1.0.0" });
  await client.connect(clientT);

  console.log("=== Server capabilities (from initialize response) ===");
  console.log(JSON.stringify(client.getServerCapabilities(), null, 2));

  console.log("\n=== tools/list ===");
  const { tools } = await client.listTools();
  console.log(JSON.stringify(tools, null, 2));

  console.log("\n=== resources/list ===");
  const { resources } = await client.listResources();
  console.log(JSON.stringify(resources, null, 2));

  await client.close();
  await server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
