/**
 * MCP Tool Creation
 *
 * Factory functions for creating MCP tools that work like regular tools:
 * - Pass to models: engine.execute({ tools: [tool] })
 * - Run directly: await tool.run(input)
 * - Use in JSX: <MyMCPTool />
 *
 * Three main entry points:
 * 1. createMCPTool() - Component factory with discovery, for JSX usage
 * 2. createMCPToolFromDefinition() - Direct creation from known definition
 * 3. discoverMCPTools() - Batch discovery of all tools on a server
 */

import { type Component } from "../component/component";
import { MCPClient } from "./client";
import { MCPService } from "./service";
import type { MCPConfig, MCPServerConfig, MCPToolDefinition } from "./types";
import type { ExecutableTool } from "../tool/tool";
import { MCPTool, type MCPToolConfig } from "./tool";
import { MCPToolComponent, type MCPToolComponentProps } from "./component";

// ============================================================================
// Config Utilities
// ============================================================================

/**
 * Normalizes Cursor-style config to full MCPConfig.
 *
 * Cursor-style: { command: 'npx', args: [...], env: {...} }
 * Full MCPConfig: { serverName, transport, connection: {...} }
 */
export function normalizeMCPConfig(
  serverName: string,
  config: MCPServerConfig | MCPConfig,
): MCPConfig {
  // Already a full MCPConfig
  if ("transport" in config && "connection" in config) {
    return config as MCPConfig;
  }

  // Convert Cursor-style to MCPConfig (assumes stdio transport)
  const c = config as MCPServerConfig;
  return {
    serverName,
    transport: "stdio",
    connection: {
      command: c.command,
      args: c.args || [],
      env: c.env,
    },
  };
}

/**
 * Merges base config with runtime overrides.
 * Runtime values take precedence.
 */
export function mergeMCPConfig(base: MCPConfig, runtime?: Partial<MCPConfig>): MCPConfig {
  if (!runtime) return base;

  return {
    ...base,
    ...runtime,
    connection: {
      ...base.connection,
      ...runtime.connection,
    },
    auth: runtime.auth || base.auth,
  };
}

// ============================================================================
// createMCPTool - Component Factory
// ============================================================================

/**
 * Options for createMCPTool().
 * Extends MCPToolComponentProps but adds `toolName` for single-tool selection.
 */
export interface CreateMCPToolOptions extends Omit<
  MCPToolComponentProps,
  "include" | "exclude" | "mcpClient"
> {
  /**
   * Specific tool name to discover.
   * If omitted, registers first tool found.
   */
  toolName?: string;

  /**
   * Shared MCPClient instance.
   * If not provided, creates a new one.
   */
  client?: MCPClient;
}

/**
 * Creates an MCP tool component that discovers and registers on mount.
 *
 * Use this when you need:
 * - Dynamic discovery at runtime
 * - Runtime configuration (auth tokens)
 * - JSX-based tool declaration
 *
 * @example Basic usage
 * ```tsx
 * const ReadFile = createMCPTool({
 *   server: 'filesystem',
 *   config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'] },
 *   toolName: 'read_file',
 * });
 *
 * function MyAgent() {
 *   return (
 *     <>
 *       <ReadFile />
 *       <Model />
 *     </>
 *   );
 * }
 * ```
 *
 * @example With runtime auth
 * ```tsx
 * const APITool = createMCPTool({
 *   server: 'api',
 *   config: { transport: 'sse', connection: { url: 'https://api.example.com/mcp' } },
 *   toolName: 'query',
 * });
 *
 * // Runtime config from user context
 * <APITool runtimeConfig={{ auth: { type: 'bearer', token: userToken } }} />
 * ```
 */
export function createMCPTool(
  options: CreateMCPToolOptions,
): new (props?: Partial<CreateMCPToolOptions>) => Component {
  // Build base props for MCPToolComponent
  const baseProps: MCPToolComponentProps = {
    server: options.server,
    config: options.config,
    // If toolName specified, only include that tool; otherwise include first tool
    include: options.toolName ? [options.toolName] : undefined,
    toolPrefix: options.toolPrefix,
    mcpClient: options.client,
  };

  // Return a class that extends MCPToolComponent with merged props
  return class SingleMCPToolComponent extends MCPToolComponent {
    constructor(props?: Partial<CreateMCPToolOptions>) {
      // Merge: baseProps -> options hooks -> runtime props
      const merged: MCPToolComponentProps = {
        ...baseProps,
        runtimeConfig: props?.runtimeConfig || options.runtimeConfig,
        mcpClient: props?.client || options.client,
        toolPrefix: props?.toolPrefix || options.toolPrefix,
        // Pass lifecycle hooks from options
        onMount: options.onMount,
        onUnmount: options.onUnmount,
        onStart: options.onStart,
        onTickStart: options.onTickStart,
        onTickEnd: options.onTickEnd,
        onComplete: options.onComplete,
        onError: options.onError,
      };
      super(merged);
    }
  };
}

// ============================================================================
// createMCPToolFromDefinition - Direct Tool Creation
// ============================================================================

/**
 * Options for createMCPToolFromDefinition().
 */
export interface CreateMCPToolFromDefinitionOptions {
  /** Active MCPClient with server connection. */
  client: MCPClient;

  /** MCP server configuration. */
  config: MCPConfig;

  /** Tool definition from discovery. */
  definition: MCPToolDefinition;

  /** Override tool name. */
  name?: string;
}

/**
 * Creates an ExecutableTool from an MCP tool definition.
 *
 * Use this when you already have:
 * - An active MCPClient connection
 * - The tool definition from discovery
 *
 * @example
 * ```typescript
 * const client = new MCPClient();
 * const service = new MCPService(client);
 *
 * // Connect and discover
 * const config: MCPConfig = {
 *   serverName: 'filesystem',
 *   transport: 'stdio',
 *   connection: { command: 'npx', args: [...] }
 * };
 * const tools = await service.connectAndDiscover(config);
 *
 * // Create specific tool
 * const readFile = createMCPToolFromDefinition({
 *   client,
 *   config,
 *   definition: tools.find(t => t.name === 'read_file')!,
 * });
 *
 * // Pass to model
 * engine.execute({ tools: [readFile] });
 *
 * // Or run directly
 * const result = await readFile.run({ path: '/file.txt' });
 * ```
 */
export function createMCPToolFromDefinition(
  options: CreateMCPToolFromDefinitionOptions,
): ExecutableTool {
  const { client, config, definition } = options;
  const name = options.name || definition.name;

  const mcpConfig: MCPToolConfig = {
    serverName: config.serverName,
    serverUrl: config.connection.url,
    transport: config.transport,
  };

  return new MCPTool(client, config.serverName, { ...definition, name }, mcpConfig);
}

// ============================================================================
// discoverMCPTools - Batch Discovery
// ============================================================================

/**
 * Options for discoverMCPTools().
 */
export interface DiscoverMCPToolsOptions {
  /** MCP server configuration. */
  config: MCPConfig;

  /**
   * Shared MCPClient.
   * If not provided, creates a new one.
   */
  client?: MCPClient;

  /** Prefix for all tool names. */
  toolPrefix?: string;

  /**
   * Whitelist: only include these tools.
   * Takes precedence over exclude.
   */
  include?: string[];

  /** Blacklist: exclude these tools. */
  exclude?: string[];
}

/**
 * Discovers all tools from an MCP server and creates ExecutableTools.
 *
 * Use this for batch tool registration or when you need all tools
 * from a server without JSX.
 *
 * @example Basic discovery
 * ```typescript
 * const tools = await discoverMCPTools({
 *   config: {
 *     serverName: 'filesystem',
 *     transport: 'stdio',
 *     connection: { command: 'npx', args: [...] }
 *   },
 * });
 *
 * // Pass all to model
 * engine.execute({ tools });
 * ```
 *
 * @example With filtering
 * ```typescript
 * const tools = await discoverMCPTools({
 *   config,
 *   include: ['read_file', 'list_directory'], // Only these
 *   toolPrefix: 'fs_',
 * });
 * ```
 *
 * @example Register with COM
 * ```typescript
 * const tools = await discoverMCPTools({ config });
 * tools.forEach(tool => com.addTool(tool));
 * ```
 */
export async function discoverMCPTools(
  options: DiscoverMCPToolsOptions,
): Promise<ExecutableTool[]> {
  const { config } = options;
  const client = options.client ?? new MCPClient();
  const service = new MCPService(client);

  // Discover
  let definitions = await service.connectAndDiscover(config);

  // Filter
  if (options.include?.length) {
    definitions = definitions.filter((t) => options.include!.includes(t.name));
  } else if (options.exclude?.length) {
    definitions = definitions.filter((t) => !options.exclude!.includes(t.name));
  }

  // Create tools
  return definitions.map((def) => {
    const name = options.toolPrefix ? `${options.toolPrefix}${def.name}` : def.name;

    return createMCPToolFromDefinition({
      client,
      config,
      definition: def,
      name,
    });
  });
}
