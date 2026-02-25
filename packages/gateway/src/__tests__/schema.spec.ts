import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createTestGateway, createMockApp } from "../testing.js";
import type { TestGatewayResult } from "../testing.js";
import {
  BUILT_IN_METHOD_SCHEMAS,
  GATEWAY_EVENTS,
  PROTOCOL_ERROR_CODES,
} from "../method-schemas.js";
import { MODEL_EVENT_TYPES, ORCHESTRATION_EVENT_TYPES, RESULT_EVENT_TYPES } from "@agentick/shared";
import { method } from "../types.js";

const EchoParams = z.object({ text: z.string() });
const EchoResponse = z.object({ echo: z.string() });
const AdminParams = z.object({ sessionId: z.string() });

describe("schema method", () => {
  let env: TestGatewayResult;

  beforeEach(async () => {
    env = await createTestGateway({
      apps: { test: createMockApp() },
      defaultApp: "test",
      methods: {
        "custom:echo": method({
          description: "Echo back input",
          schema: EchoParams,
          response: EchoResponse,
          handler: async (params) => ({ echo: params.text }),
        }),
        "admin:nuke": method({
          description: "Admin-only destructive action",
          schema: AdminParams,
          roles: ["admin"],
          handler: async () => ({ ok: true }),
        }),
      },
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Payload Shape
  // ═══════════════════════════════════════════════════════════════════════

  it("returns unified methods record (not builtInMethods array)", async () => {
    const res = await env.client.request("schema");
    expect(res.ok).toBe(true);

    const payload = res.payload as any;
    expect(payload.protocolVersion).toBe("1.0");
    expect(payload.methods).toBeDefined();
    expect(typeof payload.methods).toBe("object");

    // Old shape must be gone
    expect(payload.builtInMethods).toBeUndefined();
    expect(payload.customMethods).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Built-in Methods
  // ═══════════════════════════════════════════════════════════════════════

  it("every entry in BUILT_IN_METHOD_SCHEMAS appears in methods", async () => {
    const res = await env.client.request("schema");
    const methods = (res.payload as any).methods;

    for (const name of BUILT_IN_METHOD_SCHEMAS.keys()) {
      expect(methods[name]).toBeDefined();
      expect(methods[name].builtin).toBe(true);
    }
  });

  it("methods.send has builtin: true and params with sessionId", async () => {
    const res = await env.client.request("schema");
    const send = (res.payload as any).methods.send;

    expect(send.builtin).toBe(true);
    expect(send.description).toBe("Send message to session");
    expect(send.params).toBeDefined();
    expect(send.params.properties.sessionId).toBeDefined();
    expect(send.params.required).toContain("sessionId");
    expect(send.params.properties.input).toBeDefined();
    expect(send.params.properties.message).toBeDefined();
  });

  it("methods.send has response with messageId", async () => {
    const res = await env.client.request("schema");
    const send = (res.payload as any).methods.send;

    expect(send.response).toBeDefined();
    expect(send.response.properties.messageId).toBeDefined();
  });

  it("methods.status has response with gateway object", async () => {
    const res = await env.client.request("schema");
    const status = (res.payload as any).methods.status;

    expect(status.response).toBeDefined();
    expect(status.response.properties.gateway).toBeDefined();
    expect(status.response.required).toContain("gateway");
  });

  it("methods.schema has no params and no response (it IS the schema method)", async () => {
    const res = await env.client.request("schema");
    const schema = (res.payload as any).methods.schema;

    expect(schema).toBeDefined();
    expect(schema.builtin).toBe(true);
    expect(schema.params).toBeUndefined();
    expect(schema.response).toBeUndefined();
  });

  it("methods with errors list the applicable error codes", async () => {
    const res = await env.client.request("schema");
    const methods = (res.payload as any).methods;

    expect(methods.send.errors).toContain("NOT_FOUND_RESOURCE");
    expect(methods["tool-dispatch"].errors).toContain("NOT_FOUND_TOOL");
    expect(methods["tool-dispatch"].errors).toContain("NOT_FOUND_RESOURCE");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Custom Methods
  // ═══════════════════════════════════════════════════════════════════════

  it("custom methods have builtin: false", async () => {
    const res = await env.client.request("schema");
    const custom = (res.payload as any).methods["custom:echo"];

    expect(custom).toBeDefined();
    expect(custom.builtin).toBe(false);
    expect(custom.description).toBe("Echo back input");
  });

  it("custom method params schema is converted to JSON Schema", async () => {
    const res = await env.client.request("schema");
    const custom = (res.payload as any).methods["custom:echo"];

    expect(custom.params).toBeDefined();
    expect(custom.params.type).toBe("object");
    expect(custom.params.properties.text).toBeDefined();
    expect(custom.params.properties.text.type).toBe("string");
  });

  it("custom method response schema is converted to JSON Schema", async () => {
    const res = await env.client.request("schema");
    const custom = (res.payload as any).methods["custom:echo"];

    expect(custom.response).toBeDefined();
    expect(custom.response.type).toBe("object");
    expect(custom.response.properties.echo).toBeDefined();
    expect(custom.response.properties.echo.type).toBe("string");
  });

  it("role-guarded custom method exposes roles in schema", async () => {
    const res = await env.client.request("schema");
    const admin = (res.payload as any).methods["admin:nuke"];

    expect(admin).toBeDefined();
    expect(admin.builtin).toBe(false);
    expect(admin.roles).toEqual(["admin"]);
    expect(admin.description).toBe("Admin-only destructive action");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Events
  // ═══════════════════════════════════════════════════════════════════════

  it("events is array of { type, category } objects", async () => {
    const res = await env.client.request("schema");
    const events = (res.payload as any).events;

    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    for (const entry of events) {
      expect(typeof entry.type).toBe("string");
      expect(typeof entry.category).toBe("string");
      expect(["model", "orchestration", "result", "gateway"]).toContain(entry.category);
    }
  });

  it("spot-check event categories", async () => {
    const res = await env.client.request("schema");
    const events = (res.payload as any).events as Array<{ type: string; category: string }>;

    const byType = new Map(events.map((e) => [e.type, e.category]));

    expect(byType.get("content_delta")).toBe("model");
    expect(byType.get("execution_start")).toBe("orchestration");
    expect(byType.get("result")).toBe("result");
    expect(byType.get("channel")).toBe("gateway");
    expect(byType.get("method:chunk")).toBe("gateway");
  });

  it("events length matches shared array lengths + gateway events", async () => {
    const res = await env.client.request("schema");
    const events = (res.payload as any).events;

    const expected =
      MODEL_EVENT_TYPES.length + ORCHESTRATION_EVENT_TYPES.length + RESULT_EVENT_TYPES.length + 4; // channel, method:chunk, method:end, config:changed
    expect(events.length).toBe(expected);
  });

  it("events contain correct names (no wrong names from Phase 1)", async () => {
    const res = await env.client.request("schema");
    const events = (res.payload as any).events as Array<{ type: string }>;
    const types = new Set(events.map((e) => e.type));

    // Correct names
    expect(types.has("tool_call_start")).toBe(true);
    expect(types.has("tool_confirmation_required")).toBe(true);
    expect(types.has("provider_request")).toBe(true);

    // Wrong names that Phase 1 had (must NOT be present)
    expect(types.has("tool_start")).toBe(false);
    expect(types.has("tool_end")).toBe(false);
    expect(types.has("tool_confirmation")).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Error Codes
  // ═══════════════════════════════════════════════════════════════════════

  it("errors is Record<string, string> with all PROTOCOL_ERROR_CODES", async () => {
    const res = await env.client.request("schema");
    const errors = (res.payload as any).errors;

    expect(typeof errors).toBe("object");
    for (const [code, desc] of Object.entries(PROTOCOL_ERROR_CODES)) {
      expect(errors[code]).toBe(desc);
    }
  });

  it("errors contains shared AgentickErrorCode values", async () => {
    const res = await env.client.request("schema");
    const errors = (res.payload as any).errors;

    expect(errors.NOT_FOUND_RESOURCE).toBeDefined();
    expect(errors.NOT_FOUND_TOOL).toBeDefined();
    expect(errors.GUARD_DENIED).toBeDefined();
    expect(errors.VALIDATION_REQUIRED).toBeDefined();
  });

  it("errors contains gateway-specific codes", async () => {
    const res = await env.client.request("schema");
    const errors = (res.payload as any).errors;

    expect(errors.METHOD_ERROR).toBeDefined();
    expect(errors.INTERNAL_ERROR).toBeDefined();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Error Code Wiring (RPC catch block)
  // ═══════════════════════════════════════════════════════════════════════

  it("bad sessionId returns NOT_FOUND_RESOURCE error code", async () => {
    const res = await env.client.request("abort", { sessionId: "nonexistent-session-id" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("NOT_FOUND_RESOURCE");
  });

  it("unknown method returns NOT_FOUND_RESOURCE error code", async () => {
    const res = await env.client.request("totally-bogus-method", {});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("NOT_FOUND_RESOURCE");
  });

  it("role-guarded method returns GUARD_DENIED without proper roles", async () => {
    // Test client authenticates without any user roles, so the admin guard should fire
    const res = await env.client.request("admin:nuke", { sessionId: "test" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("GUARD_DENIED");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Adversarial
  // ═══════════════════════════════════════════════════════════════════════

  it("schema is idempotent (two calls produce deep-equal results)", async () => {
    const res1 = await env.client.request("schema");
    const res2 = await env.client.request("schema");

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res1.payload).toEqual(res2.payload);
  });

  it("GATEWAY_EVENTS matches the snapshot from BUILT_IN constants", () => {
    const modelCount = GATEWAY_EVENTS.filter((e) => e.category === "model").length;
    const orchCount = GATEWAY_EVENTS.filter((e) => e.category === "orchestration").length;
    const resultCount = GATEWAY_EVENTS.filter((e) => e.category === "result").length;
    const gwCount = GATEWAY_EVENTS.filter((e) => e.category === "gateway").length;

    expect(modelCount).toBe(MODEL_EVENT_TYPES.length);
    expect(orchCount).toBe(ORCHESTRATION_EVENT_TYPES.length);
    expect(resultCount).toBe(RESULT_EVENT_TYPES.length);
    expect(gwCount).toBe(4);
  });

  it("custom method without response schema has no response in entry", async () => {
    // admin:nuke has no response schema defined
    const res = await env.client.request("schema");
    const admin = (res.payload as any).methods["admin:nuke"];

    expect(admin.params).toBeDefined();
    expect(admin.response).toBeUndefined();
  });
});
