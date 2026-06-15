/**
 * @agentick/mcp-next — MCP client harness.
 *
 * Connects an agentick session to N Model Context Protocol servers.
 * One `McpClientHarness` per server, each owning a connection + auth
 * + protocol stack independently. Server discovery registers tools
 * into the local `ToolExecutor`; inbound `elicitation/create` from
 * servers routes through `bridges.elicitation`. Designed against the
 * MCP `draft` spec going forward; supports the latest official
 * (`2025-11-25`) via an era-codec layer.
 *
 * Private workspace package. Bundled into the `agentick` metapackage;
 * not published independently.
 *
 * Status:
 *   ✅ OAuth provider interface + DefaultOAuthProvider + OAuthCallbackServer (#1)
 *   ✅ protocol/errors (sanitization, builders) + completions (sugar) (#1)
 *   ✅ in-memory + stdio transports
 *   ✅ McpClientHarness — Transport / Auth / Protocol / Lifecycle (#2)
 *   ⏳ withMCP extension + ToolBridge (#3)
 *   ⏳ ElicitationBridge (#4)
 *   ⏳ OAuth + URL-mode elicitation + Streamable HTTP (#5)
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 */

// Side-effect import — registers the `bridges.mcp` slot on
// `HookBridges` via TypeScript module augmentation. Per ADR 27, every
// harness package owns its own slot declaration.
import "./augment.js";

export * from "./protocol/index.js";
export * from "./transport/index.js";
export * from "./client/index.js";
export type { McpHookBridge } from "./bridge-types.js";

// OAuth is also re-exported on the `/oauth` subpath for adopters who
// only need the OAuth utilities (CLI bootstrap, custom providers).
export {
  DefaultOAuthProvider,
  OAuthCallbackServer,
  createSDKProvider,
  type DefaultOAuthProviderOptions,
  type OAuthCallbackServerOptions,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthDiscoveryState,
  type OAuthProvider,
  type OAuthTokens,
  type SDKOAuthClientProvider,
} from "./oauth/index.js";
