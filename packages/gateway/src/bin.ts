#!/usr/bin/env node
/**
 * Gateway CLI
 *
 * Run the gateway daemon from the command line.
 */

import { createGateway } from "./gateway.js";

// For now, just a placeholder that shows usage
console.log("@tentickle/gateway");
console.log("");
console.log("Usage:");
console.log("  The gateway is typically started programmatically:");
console.log("");
console.log("  ```typescript");
console.log("  import { createGateway } from '@tentickle/gateway';");
console.log("  import { createApp } from '@tentickle/core';");
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
console.log("  tentickle-gateway --config ./gateway.config.ts");
