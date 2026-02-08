#!/usr/bin/env node
/**
 * Agentick CLI - Entry point
 */

import { program } from "commander";
import { chatCommand } from "./commands/chat.js";
import { sendCommand } from "./commands/send.js";
import { statusCommand } from "./commands/status.js";

program.name("agentick").description("Terminal client for Agentick agents").version("0.0.1");

// Chat command (interactive)
program
  .command("chat")
  .description("Interactive chat with a Agentick agent")
  .option("-u, --url <url>", "Server URL (e.g., http://localhost:3000/api/agent)")
  .option("-s, --session <id>", "Session ID")
  .option("-t, --token <token>", "Authentication token")
  .option("--no-stream", "Disable streaming (wait for complete response)")
  .option("--debug", "Enable debug mode")
  .action(chatCommand);

// Send command (non-interactive)
program
  .command("send <message>")
  .description("Send a single message and print the response")
  .option("-u, --url <url>", "Server URL")
  .option("-s, --session <id>", "Session ID")
  .option("-t, --token <token>", "Authentication token")
  .option("--stdin", "Read additional context from stdin")
  .option("-f, --format <format>", "Output format: plain, json, markdown", "plain")
  .option("--no-stream", "Disable streaming")
  .action(sendCommand);

// Status command
program
  .command("status")
  .description("Show server and session status")
  .option("-u, --url <url>", "Server URL")
  .option("-s, --session <id>", "Session ID")
  .option("-t, --token <token>", "Authentication token")
  .action(statusCommand);

// Default to chat if no command specified
program.action(() => {
  program.help();
});

program.parse();
