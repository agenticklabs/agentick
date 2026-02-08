#!/usr/bin/env node
/**
 * Gateway CLI
 *
 * Run the gateway daemon from the command line.
 */

import { createGateway } from "./gateway.js";

// For now, just a placeholder that shows usage
console.log("@agentick/gateway");
console.log("");
console.log("Usage:");
console.log("  The gateway is typically started programmatically:");
console.log("");
console.log("  ```typescript");
console.log("  import { createGateway } from '@agentick/gateway';");
console.log("  import { createApp } from '@agentick/core';");
console.log("");
console.log("  const Agent = () => (");
console.log("    <>");
console.log("      <Model model={gpt4} />");
console.log("      <System>You are a helpful assistant.</System>");
console.log("      <Timeline />");
console.log("    </>");
console.log("  );");
console.log("");
console.log("  const gateway = createGateway({");
console.log("    agents: { chat: createApp(Agent) },");
console.log("    defaultAgent: 'chat',");
console.log("    port: 18789,");
console.log("  });");
console.log("");
console.log("  await gateway.start();");
console.log("  ```");
console.log("");
console.log("Future versions will support a config file:");
console.log("  agentick-gateway --config ./gateway.config.ts");
