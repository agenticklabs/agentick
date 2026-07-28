/**
 * Wire constants both sides of a transport need.
 *
 * A header name is not a server concern — the client has to SEND what the
 * server CHECKS. Keeping the constant in `server/` forced the HTTP client
 * transport to import a Node-only module (`node:crypto` via
 * `web-security.ts`), which broke browser bundles. Shared wire facts live
 * here so neither door pulls the other's runtime.
 */

/** Header carrying the CSRF token on cross-origin browser mutations. */
export const CSRF_HEADER = "x-agentick-csrf";
