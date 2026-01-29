# MCP Tool Usage Guide

## Unified Configuration Format

Both `EngineConfig.mcpServers` and `MCPToolComponent` use the **same configuration format**:

### Cursor-Style (Simplified)

```typescript
{
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
  env?: { MCP_API_KEY: 'secret' }, // Optional
}
```

### Full MCPConfig Format

```typescript
{
  serverName: 'postgres',
  transport: 'stdio' | 'sse' | 'websocket',
  connection: {
    command?: string,
    args?: string[],
    url?: string,
    env?: Record<string, string>,
  },
  auth?: {
    type: 'bearer' | 'api_key' | 'custom',
    token?: string,
  },
}
```

## Three Ways to Use MCP Tools

### 1. EngineConfig (Automatic - All Executions)

```typescript
const engine = new Engine({
  model: myModel,
  mcpServers: {
    postgres: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    },
  },
});

// Tools automatically available for all executions
await engine.execute(input, <MyAgent />);
```

**Use when:**

- Same MCP servers for all executions
- Static configuration
- Simple setup

### 2. MCPToolComponent in JSX (Per-Agent)

```tsx
import { MCPTool } from 'tentickle';

const engine = new Engine({ model: myModel });

// Use in your agent component tree
function MyAgent() {
  return (
    <>
      <MCPTool
        server="postgres"
        config={{
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
        }}
      />
      {/* Other components */}
    </>
  );
}

await engine.execute(input, <MyAgent />);
```

**Use when:**

- Different agents need different MCP servers
- Conditional tool loading
- Per-agent configuration

### 3. MCPToolComponent with Runtime Config (Dynamic Auth)

```tsx
import { MCPTool } from 'tentickle';

function MyAgent({ userApiToken }: { userApiToken: string }) {
  return (
    <>
      <MCPTool
        server="api-server"
        config={{
          transport: 'sse',
          connection: {
            url: 'https://api.example.com/mcp',
          },
        }}
        runtimeConfig={{
          auth: {
            type: 'bearer',
            token: userApiToken, // From user context!
          },
        }}
        exclude={['dangerous_tool']} // Filter out unsafe tools
        toolPrefix="api_" // Prefix tool names: api_read_data
      />
    </>
  );
}

// Pass user context
await engine.execute(
  input,
  <MyAgent userApiToken={userContext.apiToken} />
);
```

**Use when:**

- User-specific auth tokens
- Dynamic configuration
- Runtime tool filtering
- Tool name prefixing (avoid conflicts)

## Advanced Features

### Tool Filtering

```tsx
// Whitelist: Only these tools
<MCPTool
  server="filesystem"
  config={{ command: 'npx', args: [...] }}
  include={['read_file', 'list_directory']}
/>

// Blacklist: All tools except these
<MCPTool
  server="filesystem"
  config={{ command: 'npx', args: [...] }}
  exclude={['delete_file', 'write_file']}
/>
```

### Shared MCP Client (Connection Pooling)

```tsx
import { MCPClient, MCPTool } from 'tentickle';

// Create shared client
const sharedClient = new MCPClient();

function MyAgent() {
  return (
    <>
      {/* Both use same client connection */}
      <MCPTool
        server="postgres"
        config={{ command: 'npx', args: [...] }}
        mcpClient={sharedClient}
      />
      <MCPTool
        server="filesystem"
        config={{ command: 'npx', args: [...] }}
        mcpClient={sharedClient}
      />
    </>
  );
}
```

### Runtime Config Updates

```tsx
class MyAgent extends Component {
  private mcpToolRef?: MCPToolComponent;

  async onStart(com: COM) {
    // Update runtime config (e.g., refresh auth token)
    if (this.mcpToolRef) {
      await this.mcpToolRef.updateRuntimeConfig(com, {
        auth: {
          type: 'bearer',
          token: await this.refreshToken(),
        },
      });
    }
  }
}
```

## Configuration Merging

Runtime config **merges** with base config (runtime overrides base):

```tsx
// Base config
config={{
  transport: 'stdio',
  connection: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
  },
  auth: {
    type: 'bearer',
    token: 'default-token',
  },
}}

// Runtime config (overrides auth.token)
runtimeConfig={{
  auth: {
    token: 'user-specific-token', // Overrides default-token
  },
}}

// Effective config:
{
  transport: 'stdio',
  connection: { command: 'npx', args: [...] },
  auth: { type: 'bearer', token: 'user-specific-token' },
}
```

## Complete Example

```tsx
import { Engine, MCPTool } from 'tentickle';

const engine = new Engine({
  model: myModel,
  // Optionally configure some servers at Engine level
  mcpServers: {
    common: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/packages/path'],
    },
  },
});

function UserAgent({ userId, apiToken }: { userId: string; apiToken: string }) {
  return (
    <>
      {/* Engine-level MCP server (already registered) */}

      {/* User-specific MCP server with runtime auth */}
      <MCPTool
        server="user-api"
        config={{
          transport: 'sse',
          connection: {
            url: 'https://api.example.com/mcp',
          },
        }}
        runtimeConfig={{
          auth: {
            type: 'bearer',
            token: apiToken, // User-specific!
          },
        }}
        exclude={['admin_tools']} // Filter out admin tools for regular users
        toolPrefix="user_" // Prefix: user_get_data, user_update_profile
      />

      {/* Conditional MCP server (only for premium users) */}
      {userId.startsWith('premium_') && (
        <MCPTool
          server="premium-features"
          config={{
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-premium', '--user', userId],
          }}
          include={['advanced_search', 'analytics']} // Only premium tools
        />
      )}
    </>
  );
}

await engine.execute(
  input,
  <UserAgent userId={user.id} apiToken={user.apiToken} />
);
```

## Key Benefits

1. **Unified Config Format**: Same format for EngineConfig and ComponentTool
2. **Runtime Configuration**: User-specific auth, dynamic URLs, etc.
3. **Tool Filtering**: Include/exclude lists for security
4. **Tool Prefixing**: Avoid name conflicts
5. **Conditional Loading**: Load tools based on user/context
6. **Connection Sharing**: Share MCPClient across components
7. **Easy JSX Usage**: `<MCPTool server="..." config={...} />`
