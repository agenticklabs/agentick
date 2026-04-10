export { MCPServer } from "./server.js";

// Security — function types re-exported from protocol, defaults and pipeline from security module
export {
  localOnlyGuard,
  rejectAllAuth,
  allowAllGuard,
  allowAllAuth,
  allowAllAuthz,
  allowAllRateLimit,
  passthroughSanitizer,
  resolveSecurityDefaults,
} from "./security/index.js";

export { SecurityError } from "./security/index.js";
