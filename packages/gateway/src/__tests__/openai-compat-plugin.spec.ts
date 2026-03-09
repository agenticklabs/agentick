/**
 * OpenAI-Compatible Inference Plugin Tests
 *
 * Tests the /v1/models and /v1/chat/completions endpoints,
 * model mapping, error handling, route lifecycle.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Gateway, createGateway } from "../index.js";
import { openaiCompatPlugin } from "../plugins/openai-compat.js";
import { createMockApp } from "@agentick/core/testing";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestGateway() {
  const app = createMockApp();
  return createGateway({
    apps: { chat: app, "gpt-4": app },
    defaultApp: "chat",
    embedded: true,
  });
}

/** Simple mock HTTP pair — no body streaming, just req.body pre-set */
function mockHTTP(path: string, method = "GET", body?: unknown) {
  const chunks: Buffer[] = [];
  const req = {
    method,
    url: path,
    headers: { host: "localhost", "content-type": "application/json" },
    body: body ?? undefined,
    on: vi.fn(),
  } as any;

  const res = {
    statusCode: 200,
    headersSent: false,
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      this.headersSent = true;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) this._headers[k.toLowerCase()] = v;
      }
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.headersSent = true;
    },
    on: vi.fn(),
  } as any;

  return {
    req,
    res,
    body: () => Buffer.concat(chunks).toString(),
    json: () => JSON.parse(Buffer.concat(chunks).toString()),
  };
}

/** Mock HTTP pair with streaming body (for testing body parser) */
function mockHTTPWithStreamBody(path: string, method: string, bodyStr: string) {
  let dataCallback: any;
  let endCallback: any;
  const chunks: Buffer[] = [];

  const req = {
    method,
    url: path,
    headers: { host: "localhost", "content-type": "application/json" },
    on: vi.fn((event: string, cb: any) => {
      if (event === "data") dataCallback = cb;
      if (event === "end") endCallback = cb;
    }),
  } as any;

  const res = {
    statusCode: 200,
    headersSent: false,
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code;
      this.headersSent = true;
      if (headers) for (const [k, v] of Object.entries(headers)) this._headers[k.toLowerCase()] = v;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.headersSent = true;
    },
    on: vi.fn(),
  } as any;

  const deliver = () => {
    if (bodyStr) dataCallback(Buffer.from(bodyStr));
    endCallback();
  };

  return { req, res, deliver, body: () => Buffer.concat(chunks).toString() };
}

// ============================================================================
// Tests
// ============================================================================

describe("OpenAI Compat Plugin", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  it("creates plugin with default config", () => {
    const plugin = openaiCompatPlugin();
    expect(plugin.id).toBe("openai-compat");
  });

  it("creates plugin with custom id and prefix", () => {
    const plugin = openaiCompatPlugin({ id: "my-openai", pathPrefix: "/api" });
    expect(plugin.id).toBe("my-openai");
  });

  describe("/v1/models", () => {
    it("returns list of apps as models", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, json } = mockHTTP("/v1/models", "GET");
      await gateway.handleRequest(req, res);

      expect(res.statusCode).toBe(200);
      const data = json();
      expect(data.object).toBe("list");
      expect(data.data).toHaveLength(2);
      expect(data.data[0].object).toBe("model");
      expect(data.data[0].owned_by).toBe("agentick");
      const ids = data.data.map((m: any) => m.id).sort();
      expect(ids).toEqual(["chat", "gpt-4"]);
    });
  });

  describe("/v1/chat/completions", () => {
    it("returns 400 for missing messages", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, json } = mockHTTP("/v1/chat/completions", "POST", { model: "chat" });
      await gateway.handleRequest(req, res);

      expect(res.statusCode).toBe(400);
      expect(json().error.type).toBe("invalid_request_error");
    });

    it("returns 400 for invalid JSON body", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, deliver } = mockHTTPWithStreamBody(
        "/v1/chat/completions",
        "POST",
        "not json{",
      );
      const p = gateway.handleRequest(req, res);
      // Let async dispatch (auth check) complete before delivering body
      await new Promise((r) => setTimeout(r, 0));
      deliver();
      await p;

      expect(res.statusCode).toBe(400);
    });
  });

  describe("error format", () => {
    it("returns OpenAI-format errors for unknown endpoints", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, json } = mockHTTP("/v1/unknown-endpoint", "POST");
      await gateway.handleRequest(req, res);

      expect(res.statusCode).toBe(404);
      const err = json().error;
      expect(err.message).toContain("Unknown endpoint");
      expect(err.type).toBe("not_found");
    });
  });

  describe("route lifecycle", () => {
    it("cleans up route on destroy", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      // Route exists
      const { req: r1, res: s1 } = mockHTTP("/v1/models", "GET");
      await gateway.handleRequest(r1, s1);
      expect(s1.statusCode).toBe(200);

      // Remove plugin
      await gateway.remove("openai-compat");

      // Route gone
      const { req: r2, res: s2 } = mockHTTP("/v1/models", "GET");
      await gateway.handleRequest(r2, s2);
      expect(s2.statusCode).toBe(404);
    });

    it("supports custom path prefix", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin({ pathPrefix: "/api/v1" }));

      const { req, res, json } = mockHTTP("/api/v1/models", "GET");
      await gateway.handleRequest(req, res);

      expect(res.statusCode).toBe(200);
      expect(json().object).toBe("list");
    });
  });
});
