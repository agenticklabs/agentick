/**
 * The server half — a gateway hosting the coding agent app.
 *
 * This is the "backend": substrate lives here, the model runs here, tools
 * execute here. The client (src/client.ts) reaches it over an in-process
 * transport. Swap `inProcessTransport` for a WebSocket/HTTP server transport
 * and this exact code serves a remote browser client unchanged.
 */

import React from "react";
import { createGateway } from "@agentick/gateway";
import { reactCompiler } from "@agentick/compiler-react";
import { aisdk } from "@agentick/model-ai-sdk";
import { openai } from "@ai-sdk/openai";
import type { GatewayHarnessProtocol } from "@agentick/spec";

import { CodingAgent } from "./agent.js";
import { setWorkspaceRoot } from "./tools.js";

export interface CodingServer {
  readonly gateway: GatewayHarnessProtocol;
  readonly appId: string;
}

/**
 * Stand up the gateway + coding-agent app. `gateway.listen()` is mandatory
 * before `createApp`. The app wires the React compiler (`reactCompiler()`)
 * so the JSX `<CodingAgent/>` compiles into model context, and a real OpenAI
 * model so the agent actually codes.
 */
export async function startCodingServer(workspaceDir: string): Promise<CodingServer> {
  setWorkspaceRoot(workspaceDir);

  const gateway = await createGateway();
  await gateway.listen();

  const app = await gateway.createApp({
    appId: "coding",
    rootElement: React.createElement(CodingAgent),
    options: {
      model: aisdk(openai("gpt-4o-mini")),
      compiler: reactCompiler(),
    },
  });

  return { gateway, appId: app.id };
}
