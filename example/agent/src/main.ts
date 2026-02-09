import "dotenv/config";
import { createApp } from "@agentick/core";
import { createTUI } from "@agentick/tui";
import { Agent } from "./agent.js";

const app = createApp(Agent);
createTUI({ app }).start();
