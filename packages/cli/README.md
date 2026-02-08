# @agentick/cli

Terminal client for Agentick agents.

## Installation

```bash
# Global install
npm install -g @agentick/cli

# Or use npx
npx @agentick/cli chat --url http://localhost:3000/api/agent

# Or add to your project
pnpm add @agentick/cli
```

## Quick Start

```bash
# Start interactive chat
agentick chat --url http://localhost:3000/api/agent

# Send a single message
agentick send "What is 2+2?" --url http://localhost:3000/api/agent

# Check server status
agentick status --url http://localhost:3000/api/agent
```

## Commands

### `agentick chat`

Interactive chat mode with streaming responses.

```bash
agentick chat [options]

Options:
  -u, --url <url>       Server URL (or set TENTICKLE_URL)
  -s, --session <id>    Session ID (optional)
  -t, --token <token>   Authentication token (or set TENTICKLE_TOKEN)
  --no-stream           Disable streaming (wait for complete response)
  --debug               Enable debug mode
```

**In-chat commands:**

| Command            | Description             |
| ------------------ | ----------------------- |
| `/help`            | Show available commands |
| `/quit` or `/exit` | Exit the chat           |
| `/status`          | Show session status     |
| `/clear`           | Clear the screen        |
| `/debug`           | Toggle debug mode       |

### `agentick send`

Send a single message and print the response. Great for scripting.

```bash
agentick send <message> [options]

Options:
  -u, --url <url>           Server URL
  -s, --session <id>        Session ID
  -t, --token <token>       Authentication token
  --stdin                   Read additional context from stdin
  -f, --format <format>     Output format: plain, json, markdown (default: plain)
  --no-stream               Disable streaming
```

**Examples:**

```bash
# Simple message
agentick send "Hello, agent!" --url http://localhost:3000/api/agent

# Pipe file content
cat document.txt | agentick send "Summarize this:" --stdin --url $URL

# JSON output for scripting
agentick send "List 5 ideas" --format json --url $URL | jq '.response'

# Non-streaming (wait for complete response)
agentick send "Complex question" --no-stream --url $URL
```

### `agentick status`

Show server and session status.

```bash
agentick status [options]

Options:
  -u, --url <url>       Server URL
  -s, --session <id>    Session ID
  -t, --token <token>   Authentication token
```

## Configuration

### Environment Variables

```bash
export TENTICKLE_URL="http://localhost:3000/api/agent"
export TENTICKLE_TOKEN="your-auth-token"
export TENTICKLE_SESSION="my-session"
export TENTICKLE_DEBUG="1"
```

### Config File

Create `~/.agentick/config.json`:

```json
{
  "defaultUrl": "http://localhost:3000/api/agent",
  "defaultToken": "your-auth-token",
  "debug": false,
  "aliases": {
    "local": "http://localhost:3000/api/agent",
    "prod": "https://api.example.com/agent"
  }
}
```

With aliases, you can use:

```bash
agentick chat --url local
agentick chat --url prod
```

### Priority

Configuration is loaded in this order (later overrides earlier):

1. Config file (`~/.agentick/config.json`)
2. Environment variables
3. CLI arguments

## Output Formats

### Plain (default)

Raw text output, suitable for reading or piping.

```bash
agentick send "Hello" --format plain
# Hello! How can I help you today?
```

### JSON

Structured output for scripting.

```bash
agentick send "Hello" --format json
# {
#   "response": "Hello! How can I help you today?",
#   "sessionId": "sess-abc123"
# }
```

### Markdown

Rendered markdown in terminal (with colors and formatting).

```bash
agentick send "Show me code" --format markdown
```

## Features

### Streaming

By default, responses stream to your terminal as they're generated:

```
You: What's the weather like?

Agent: Let me check that for you...
[tool: web_search] Searching...

The current weather in your area is 72°F with partly cloudy skies.
```

Disable with `--no-stream` to wait for the complete response.

### Tool Execution

Tool calls are shown inline:

```
Agent: I'll search for that information.
[tool: web_search] {"query": "latest news"}

Based on my search, here are the top stories...
```

### Debug Mode

Enable debug mode to see what's happening under the hood:

```bash
agentick chat --debug

# Or toggle during chat
/debug
```

Debug output shows:

- Request/response details
- Stream events
- Token usage

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│    CLI      │────►│ @agentick/client │────►│ Agentick Server│
│             │     │                  │     │                 │
│  - chat     │     │  - SSE transport │     │  - Express      │
│  - send     │     │  - Session mgmt  │     │  - Gateway      │
│  - status   │     │  - Event stream  │     │                 │
└─────────────┘     └──────────────────┘     └─────────────────┘
```

The CLI uses `@agentick/client` under the hood, which means:

- Works with any Agentick server (Express, Gateway, etc.)
- Automatic transport detection (SSE for http://, WebSocket for ws://)
- Same session management as web clients

## Development

```bash
# Clone the repo
git clone https://github.com/your-org/agentick.git
cd agentick

# Install dependencies
pnpm install

# Run CLI in development
cd packages/cli
pnpm cli --help
pnpm cli chat --url http://localhost:3000/api/agent
```

### Building

```bash
pnpm build
```

### Testing

```bash
pnpm test
```

## Programmatic Usage

The CLI can also be used as a library:

```typescript
import { CLI, createCLI } from "@agentick/cli";

const cli = createCLI({
  url: "http://localhost:3000/api/agent",
  token: "your-token",
});

// Listen for events
cli.on("stream:delta", ({ text }) => {
  process.stdout.write(text);
});

cli.on("tool:start", ({ name }) => {
  console.log(`[tool: ${name}]`);
});

// Send a message
const response = await cli.send("Hello, agent!");
console.log("Response:", response);

// Stream a message
for await (const event of cli.stream("What is 2+2?")) {
  console.log(event);
}

// Clean up
cli.destroy();
```

### ChatSession

For interactive sessions:

```typescript
import { ChatSession } from "@agentick/cli";

const session = new ChatSession({
  url: "http://localhost:3000/api/agent",
  markdown: true,
});

await session.start();
```

### Renderer

For custom terminal output:

```typescript
import { Renderer } from "@agentick/cli";

const renderer = new Renderer({
  markdown: true,
  debug: false,
});

renderer.info("Starting...");
renderer.response("Hello! How can I help?");
renderer.error("Something went wrong");
renderer.toolStart("web_search", { query: "test" });
```

## Roadmap

- [ ] Rich TUI with OpenTUI
- [ ] History navigation
- [ ] Context inspection (`/context`)
- [ ] Session management (`/sessions`, `/reset`)
- [ ] WebSocket support for Gateway
- [ ] Voice input (whisper)
- [ ] Image rendering (kitty/iTerm2)

## Related Packages

- [`@agentick/core`](../core) - JSX runtime for agents
- [`@agentick/client`](../client) - Client SDK
- [`@agentick/server`](../server) - SSE server
- [`@agentick/express`](../express) - Express middleware

## License

MIT
