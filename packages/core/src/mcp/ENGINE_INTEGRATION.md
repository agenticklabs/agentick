# MCP Server Configuration in Engine

## Overview

The Engine supports **two ways** to configure MCP servers:

1. **EngineConfig (Automatic)**: Configure MCP servers in `EngineConfig.mcpServers` - tools are automatically discovered and registered when execution begins.
2. **Manual Registration (Programmatic)**: Create `MCPClient` and `MCPService` instances and register tools manually in component lifecycle hooks.

Both approaches work! Use EngineConfig for convenience, or manual registration for dynamic/conditional tool loading.

## Configuration Format

### Cursor-Style (Simplified)

```typescript
const engine = new Engine({
  model: myModel,
  mcpServers: {
    postgres: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    },
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/allowed/path'],
      env: {
        MCP_API_KEY: 'secret-key',
      },
    },
  },
});
```

### Full MCPConfig Format (Advanced)

For more control (SSE, WebSocket, custom auth):

```typescript
const engine = new Engine({
  model: myModel,
  mcpServers: {
    'api-server': {
      serverName: 'api-server',
      transport: 'sse',
      connection: {
        url: 'https://mcp.example.com/sse',
      },
      auth: {
        type: 'bearer',
        token: 'your-token',
      },
    },
  },
});
```

## How It Works

### 1. **Configuration Mapping**

When you provide Cursor-style config, it's automatically converted to full `MCPConfig`:

```typescript
// Cursor-style:
{
  postgres: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '...'],
  }
}

// Converts to:
{
  serverName: 'postgres',
  transport: 'stdio',
  connection: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '...'],
  },
}
```

### 2. **Initialization Flow**

```
Engine Constructor
    ↓
Creates MCPClient & MCPService (if mcpServers configured)
    ↓
execute() or stream() called
    ↓
iterateTicks() called
    ↓
COM created
    ↓
initializeMCPServers(ctx) called
    ↓
For each MCP server:
  - Connect via MCPClient
  - Discover tools via SDK client.listTools()
  - Wrap each tool as MCPTool
  - Register via ctx.addTool()
    ↓
Config tools registered
    ↓
First tick begins
```

### 3. **Tool Discovery & Registration**

```typescript
// In initializeMCPServers():
for (const [serverName, config] of Object.entries(mcpServers)) {
  const mcpConfig = normalizeMCPConfig(serverName, config);

  // Connect to server
  const client = await mcpClient.connect(mcpConfig);

  // Discover tools
  const toolsList = await client.listTools();

  // Register each tool
  for (const mcpToolDef of toolsList.tools) {
    const tool = new MCPTool(mcpClient, serverName, mcpToolDef, mcpConfig);
    ctx.addTool(tool); // Registers in COM
  }
}
```

## Tool Execution Flow

### When Model Calls an MCP Tool

```
1. Model generates tool call:
   {
     name: 'query_database',
     input: { sql: 'SELECT * FROM users' }
   }
    ↓
2. ToolExecutor.executeSingleTool() called
    ↓
3. Resolve tool from COM:
   tool = ctx.getTool('query_database')
   // Returns MCPTool instance
    ↓
4. Check execution type:
   executionType = tool.metadata.type // 'mcp'
    ↓
5. Execute tool.run(input):
   MCPTool.run() → Procedure handler
    ↓
6. Forward to MCP server:
   mcpClient.callTool('postgres', 'query_database', input)
    ↓
7. SDK sends JSON-RPC request:
   {
     jsonrpc: '2.0',
     id: '...',
     method: 'tools/call',
     params: {
       name: 'query_database',
       arguments: { sql: 'SELECT * FROM users' }
     }
   }
    ↓
8. MCP server executes tool
    ↓
9. MCP server returns result:
   {
     jsonrpc: '2.0',
     id: '...',
     result: {
       content: [{ type: 'text', text: '...' }]
     }
   }
    ↓
10. MCPTool converts result to ContentBlock[]
    ↓
11. ToolExecutor returns TaskToolResult
    ↓
12. Engine adds result to context
    ↓
13. Model receives tool result in next tick
```

### Code Path

```typescript
// ToolExecutor.executeSingleTool()
const tool = ctx.getTool(call.name); // MCPTool instance
const executionType = tool.metadata.type; // 'mcp'

// Execute (same path for all execution types)
const result = await tool.run(call.input);

// MCPTool.run() implementation:
this.run = createEngineProcedure()
  .input(zodSchema)
  .handler(async (input) => {
    // Forward to MCP server
    const result = await mcpClient.callTool(serverName, toolName, input);

    // Convert to ContentBlock[]
    return convertMCPResultToContentBlocks(result);
  });
```

## Control Over Tool Presentation

### ✅ What You Can Control

1. **Which Servers to Connect**

   ```typescript
   mcpServers: {
     postgres: {...},  // Include
     // filesystem: {...},  // Exclude
   }
   ```

2. **Tool Filtering** (via custom initialization)

   ```typescript
   // Override initializeMCPServers or call manually
   const tools = await mcpService.connectAndDiscover(config);
   const filtered = tools.filter(t => t.name.startsWith('safe_'));
   for (const tool of filtered) {
     mcpService.registerMCPTool(config, tool, ctx);
   }
   ```

3. **Tool Transformation** (via custom initialization)
   ```typescript
   // Transform tool names/descriptions before registration
   const tool = new MCPTool(mcpClient, serverName, {
     ...mcpToolDef,
     name: `mcp_${mcpToolDef.name}`,
   }, mcpConfig);
   ctx.addTool(tool);
   ```

### ❌ What You Cannot Control (Without Custom Code)

- Tool names (come from MCP server)
- Tool descriptions (come from MCP server)
- Parameter schemas (come from MCP server)

## Example: Full Usage

### Option 1: EngineConfig (Automatic)

```typescript
import { Engine } from 'tentickle';
import { openai } from '@tentickle/openai';

// Create engine with MCP servers configured
const engine = new Engine({
  model: openai({ model: 'gpt-5.2' }),
  mcpServers: {
    postgres: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    },
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/safe/path'],
    },
  },
});

// Execute - MCP tools are automatically available!
const result = await engine.execute(
  { messages: [{ role: 'user', content: 'Query the database' }] },
  <MyAgent />
);

// Model can now call tools like:
// - postgres.query_database
// - filesystem.read_file
// - etc. (whatever tools the MCP servers expose)
```

### Option 2: Manual Registration (Programmatic)

```typescript
import { Engine, MCPClient, MCPService, MCPConfig } from 'tentickle';
import { EngineComponent } from 'tentickle';

// Create engine WITHOUT mcpServers config
const engine = new Engine({
  model: openai({ model: 'gpt-5.2' }),
  // No mcpServers here!
});

// In your component, manually register MCP tools
class MyAgent extends Component {
  private mcpClient?: MCPClient;
  private mcpService?: MCPService;

  async onStart(ctx: COM) {
    // Create MCP client/service instances
    this.mcpClient = new MCPClient();
    this.mcpService = new MCPService(this.mcpClient);

    // Define MCP server config (can be dynamic!)
    const postgresConfig: MCPConfig = {
      serverName: 'postgres',
      transport: 'stdio',
      connection: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
      },
    };

    // Discover and register tools manually
    await this.mcpService.discoverAndRegister(postgresConfig, ctx);

    // Or discover tools and filter/transform before registering
    const tools = await this.mcpService.connectAndDiscover(postgresConfig);
    const filteredTools = tools.filter(t => t.name.startsWith('safe_'));
    for (const toolDef of filteredTools) {
      this.mcpService.registerMCPTool(postgresConfig, toolDef, ctx);
    }
  }

  async onUnmount(ctx: COM) {
    // Cleanup MCP connections if needed
    if (this.mcpClient) {
      await this.mcpClient.disconnectAll();
    }
  }
}

// Execute - MCP tools registered manually in component
const result = await engine.execute(
  { messages: [{ role: 'user', content: 'Query the database' }] },
  <MyAgent />
);
```

### When to Use Each Approach

**Use EngineConfig (Automatic):**

- ✅ MCP servers are known at Engine creation time
- ✅ Same servers for all executions
- ✅ Simpler setup
- ✅ Tools available from first tick

**Use Manual Registration:**

- ✅ Dynamic server configuration (based on user input, environment, etc.)
- ✅ Conditional tool loading (only load tools when needed)
- ✅ Per-agent tool sets (different agents get different tools)
- ✅ Tool filtering/transformation before registration
- ✅ Runtime server discovery

## Key Points

1. **Automatic Discovery**: Tools are discovered automatically when execution starts
2. **Per-Execution**: MCP servers are initialized once per `execute()`/`stream()` call
3. **Same Pipeline**: MCP tools flow through the same pipeline as native tools
4. **Execution Type**: MCP tools have `type: 'mcp'` but execute via the same `tool.run()` interface
5. **Error Handling**: Failed MCP server initialization doesn't block execution (logs error, continues)

## Limitations

1. **No Tool Name Override**: Tool names come from MCP server (can be transformed with custom code)
2. **No Lazy Loading**: All MCP servers are initialized at execution start (not on-demand)
3. **No Tool Tracking**: Currently no way to track which tools belong to which server (for cleanup)
4. **Connection Persistence**: MCP connections persist for the Engine instance lifetime
