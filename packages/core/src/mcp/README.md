# MCP Tool Integration Guide

## Overview

MCP (Model Context Protocol) tools allow the Engine to connect to external MCP servers and use their tools as if they were native Engine tools. The flow is:

1. **Configure MCP Server** → Define connection details
2. **Discover Tools** → Connect to server and list available tools
3. **Register Tools** → Wrap MCP tools as Engine `ExecutableTool` instances
4. **Inject into Context** → Tools become available to the model via `COMInput`
5. **Execute** → When model calls tool, Engine forwards to MCP server

## Example: Setting Up MCP Tools

### 1. Define MCP Server Configuration

```typescript
import { MCPConfig } from "agentick";
import { MCPClient, MCPService } from "agentick";

// Example 1: Stdio transport (spawns a process)
const filesystemMCPConfig: MCPConfig = {
  serverName: "filesystem-mcp",
  transport: "stdio",
  connection: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
  },
};

// Example 2: SSE transport (Server-Sent Events)
const apiMCPConfig: MCPConfig = {
  serverName: "api-mcp",
  transport: "sse",
  connection: {
    url: "https://mcp.example.com/sse",
  },
  auth: {
    type: "bearer",
    token: "your-api-token",
  },
};

// Example 3: Streamable HTTP transport (modern WebSocket replacement)
const cloudMCPConfig: MCPConfig = {
  serverName: "cloud-mcp",
  transport: "websocket", // Maps to StreamableHTTPClientTransport
  connection: {
    url: "https://mcp.cloud.example.com",
  },
};
```

### 2. Initialize MCP Service and Discover Tools

```typescript
import { Engine, MCPClient, MCPService } from "agentick";

// Create MCP client (manages connections)
const mcpClient = new MCPClient();

// Create MCP service (handles discovery and registration)
const mcpService = new MCPService(mcpClient);

// Discover and register tools from MCP server
const ctx = new ContextObjectModel();
await mcpService.discoverAndRegister(filesystemMCPConfig, ctx);

// Now ctx has all tools from the filesystem MCP server registered!
```

### 3. Use in Engine Execution

**Option A: Manual Registration (Programmatic)**

```typescript
const engine = new Engine({ model: myModel });

// Create MCP client/service
const mcpClient = new MCPClient();
const mcpService = new MCPService(mcpClient);

// In your component's onMount or onStart:
class MyAgent extends Component {
  async onStart(ctx: COM) {
    // Discover MCP tools and register them manually
    await mcpService.discoverAndRegister(filesystemMCPConfig, ctx);
    // Now model can use these tools!
  }
}
```

**Option B: EngineConfig (Automatic)**

```typescript
// Configure MCP servers in EngineConfig
const engine = new Engine({
  model: myModel,
  mcpServers: {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
    },
  },
});

// Tools are automatically discovered and registered when execution starts!
// No need to manually call discoverAndRegister()
```

## How Tools Flow to the Model

### Flow Diagram

```
MCP Server
    ↓
MCPClient.connect() → SDK Client → Transport (stdio/SSE/HTTP)
    ↓
MCPService.discoverAndRegister()
    ↓
MCPTool (wraps each discovered tool)
    ↓
ContextObjectModel.addTool() → Stores in:
    - tools Map<name, ExecutableTool> (for execution)
    - toolDefinitions Map<name, ToolDefinition> (for model)
    ↓
COMInput.toInput() → Returns ToolDefinition[]
    ↓
ModelAdapter.fromEngineState() → Converts to provider format
    ↓
Model receives tools in tool calling format
```

### Code Flow

1. **Discovery**: `MCPService.connectAndDiscover()` calls SDK's `client.listTools()`
2. **Wrapping**: Each tool becomes an `MCPTool` instance (extends `Tool`, implements `ExecutableTool`)
3. **Registration**: `ctx.addTool(mcpTool)` stores:
   - `ExecutableTool` in `ctx.tools` (for execution)
   - `ToolDefinition` in `ctx.toolDefinitions` (for model)
4. **Context Building**: `ctx.toInput()` returns `COMInput` with `tools: ToolDefinition[]`
5. **Model Conversion**: `model.fromEngineState(comInput)` converts `ToolDefinition[]` to provider format

## Control Over Tool Presentation

### Current Control Points

#### 1. **Tool Name** (from MCP server)

- MCP server defines the tool name
- Used as-is in Engine
- **Control**: None (comes from MCP server)

#### 2. **Tool Description** (from MCP server)

- MCP server defines the description
- Used as-is in Engine
- **Control**: None (comes from MCP server)

#### 3. **Tool Parameters** (from MCP server)

- MCP server defines JSON Schema
- Converted to Zod schema automatically
- Converted back to JSON Schema for model
- **Control**: None (comes from MCP server)

#### 4. **Tool Filtering** (you can control this!)

```typescript
// Discover tools but filter before registering
const allTools = await mcpService.connectAndDiscover(config);
const filteredTools = allTools.filter(
  (tool) => tool.name.startsWith("allowed_"), // Only register certain tools
);

// Register manually
for (const toolDef of filteredTools) {
  mcpService.registerMCPTool(config, toolDef, ctx);
}
```

#### 5. **Tool Transformation** (you can control this!)

```typescript
// Transform tool definitions before registering
const tools = await mcpService.connectAndDiscover(config);

for (const mcpToolDef of tools) {
  // Create custom wrapper that modifies metadata
  const transformedTool = new MCPTool(
    mcpClient,
    config.serverName,
    {
      ...mcpToolDef,
      // Override description
      description: `[MCP] ${mcpToolDef.description}`,
      // Modify input schema (add prefix to name)
      name: `mcp_${mcpToolDef.name}`,
    },
    mcpConfig,
  );

  ctx.addTool(transformedTool);
}
```

#### 6. **Provider-Specific Options** (you can control this!)

```typescript
// Add provider-specific options to MCP tools
const tool = new MCPTool(mcpClient, serverName, mcpToolDef, mcpConfig);

// Modify metadata before registration
tool.metadata.providerOptions = {
  openai: {
    function: {
      strict: true, // OpenAI-specific option
    },
  },
  google: {
    grounding: false, // Google-specific option
  },
};

ctx.addTool(tool);
```

### Future Enhancement: Tool Middleware/Transformers

You could add a transformation layer:

```typescript
interface ToolTransformer {
  transform(tool: MCPToolDefinition): MCPToolDefinition | null; // null = filter out
}

class PrefixToolTransformer implements ToolTransformer {
  constructor(private prefix: string) {}

  transform(tool: MCPToolDefinition): MCPToolDefinition {
    return {
      ...tool,
      name: `${this.prefix}_${tool.name}`,
    };
  }
}

// Use in MCPService
const transformer = new PrefixToolTransformer("mcp");
const tools = await mcpService.connectAndDiscover(config);
const transformed = tools.map((t) => transformer.transform(t)).filter(Boolean);
for (const tool of transformed) {
  mcpService.registerMCPTool(config, tool, ctx);
}
```

## Execution Flow

When the model calls an MCP tool:

```
Model generates tool call: { name: 'read_file', input: { path: '/etc/passwd' } }
    ↓
ToolExecutor.executeSingleTool()
    ↓
Checks execution type: type === 'mcp'
    ↓
Calls tool.run(input) → MCPTool.run()
    ↓
MCPTool.run() → mcpClient.callTool(serverName, toolName, input)
    ↓
MCPClient.callTool() → SDK client.callTool()
    ↓
SDK sends JSON-RPC request to MCP server
    ↓
MCP server executes tool and returns result
    ↓
SDK returns result
    ↓
MCPTool converts result to ContentBlock[]
    ↓
ToolExecutor returns TaskToolResult
    ↓
Engine adds result to context
    ↓
Model receives tool result in next tick
```

## Limitations & Considerations

1. **No Tool Name Override**: Tool names come from MCP server (but you can prefix them)
2. **No Description Override**: Descriptions come from MCP server (but you can wrap/transform)
3. **Schema Conversion**: JSON Schema → Zod → JSON Schema (some edge cases might not convert perfectly)
4. **Tool Tracking**: Currently no way to track which tools belong to which MCP server (for cleanup)
5. **Connection Management**: MCP connections persist for the lifetime of MCPClient (no automatic reconnection)

## Best Practices

1. **Prefix Tool Names**: Avoid conflicts with native tools

   ```typescript
   // Transform: 'read_file' → 'mcp_filesystem_read_file'
   ```

2. **Filter Tools**: Only register tools you need

   ```typescript
   const safeTools = tools.filter((t) => !t.name.includes("delete") && !t.name.includes("write"));
   ```

3. **Add Descriptions**: Enhance MCP tool descriptions with context

   ```typescript
   description: `[Filesystem MCP] ${mcpToolDef.description}`;
   ```

4. **Use Provider Options**: Configure tool behavior per provider

   ```typescript
   providerOptions: {
     openai: { function: { strict: true } },
   }
   ```

5. **Track Tool Sources**: Keep a map of tool → server for cleanup
   ```typescript
   const toolToServer = new Map<string, string>();
   toolToServer.set("mcp_read_file", "filesystem-mcp");
   ```
