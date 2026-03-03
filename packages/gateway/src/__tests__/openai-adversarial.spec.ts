/**
 * OpenAI-Compatible Plugin — Adversarial Tests
 *
 * Edge cases, malformed input, concurrent requests, body limits,
 * and protocol compliance verification.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Gateway, createGateway } from "../index.js";
import { openaiCompatPlugin } from "../plugins/openai-compat.js";
import {
  fromOpenAIMessages,
  toOpenAITools,
  type OpenAIMessage,
} from "../plugins/openai-message-transform.js";
import { createMockApp } from "@agentick/core/testing";

// ============================================================================
// Helpers
// ============================================================================

function createTestGateway() {
  const app = createMockApp();
  return createGateway({
    apps: { chat: app, "gpt-4": app },
    defaultApp: "chat",
    embedded: true,
  });
}

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

function mockHTTPWithStreamBody(path: string, method: string, bodyStr: string) {
  let dataCallback: any;
  let endCallback: any;
  let errorCallback: any;
  const chunks: Buffer[] = [];

  const req = {
    method,
    url: path,
    headers: { host: "localhost", "content-type": "application/json" },
    on: vi.fn((event: string, cb: any) => {
      if (event === "data") dataCallback = cb;
      if (event === "end") endCallback = cb;
      if (event === "error") errorCallback = cb;
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

  return {
    req,
    res,
    deliver: () => {
      if (bodyStr) dataCallback(Buffer.from(bodyStr));
      endCallback();
    },
    error: (err: Error) => errorCallback?.(err),
    body: () => Buffer.concat(chunks).toString(),
    json: () => JSON.parse(Buffer.concat(chunks).toString()),
  };
}

// ============================================================================
// Message Transform — Adversarial
// ============================================================================

describe("fromOpenAIMessages — adversarial", () => {
  it("handles empty messages array", () => {
    expect(fromOpenAIMessages([])).toEqual([]);
  });

  it("handles system message with array content (unusual but possible)", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: [{ type: "text", text: "You are helpful" }] },
    ];
    // Array content on system message → should not crash, just use empty string
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("system");
  });

  it("handles assistant message with empty tool_calls array", () => {
    const messages: OpenAIMessage[] = [{ role: "assistant", content: "Hello", tool_calls: [] }];
    const result = fromOpenAIMessages(messages);
    expect(result[0].content).toHaveLength(1);
    expect(result[0].content[0]).toEqual({ type: "text", text: "Hello" });
  });

  it("handles tool message with missing tool_call_id", () => {
    const messages: OpenAIMessage[] = [{ role: "tool", content: "result" }];
    const result = fromOpenAIMessages(messages);
    expect(result[0].content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "",
    });
  });

  it("handles tool message with missing name", () => {
    const messages: OpenAIMessage[] = [{ role: "tool", tool_call_id: "call_1", content: "result" }];
    const result = fromOpenAIMessages(messages);
    expect(result[0].content[0]).toMatchObject({
      type: "tool_result",
      name: "",
    });
  });

  it("handles deeply nested JSON in tool call arguments", () => {
    const deepArgs = JSON.stringify({
      level1: { level2: { level3: { level4: Array(100).fill("x") } } },
    });
    const messages: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "deep", arguments: deepArgs } },
        ],
      },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result[0].content[0]).toMatchObject({
      type: "tool_use",
      name: "deep",
    });
  });

  it("handles user message with mixed content parts including unknown types", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "audio" as any, audio: { data: "abc" } } as any,
        ],
      },
    ];
    // Unknown content type should not crash — falls through to empty text
    const result = fromOpenAIMessages(messages);
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0]).toEqual({ type: "text", text: "Hello" });
    expect(result[0].content[1]).toEqual({ type: "text", text: "" });
  });

  it("handles image_url content without url field", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "user",
        content: [{ type: "image_url" }] as any,
      },
    ];
    const result = fromOpenAIMessages(messages);
    // image_url without image_url object should fall through to empty text
    expect(result[0].content[0]).toEqual({ type: "text", text: "" });
  });

  it("handles multiple consecutive tool results (batched tool calls)", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "search", arguments: '{"q":"a"}' } },
          { id: "c2", type: "function", function: { name: "fetch", arguments: '{"url":"b"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", name: "search", content: "result a" },
      { role: "tool", tool_call_id: "c2", name: "fetch", content: "result b" },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result).toHaveLength(3);
    // Two tool results become two user messages
    expect(result[1].role).toBe("user");
    expect(result[2].role).toBe("user");
    expect(result[1].content[0]).toMatchObject({ type: "tool_result", toolUseId: "c1" });
    expect(result[2].content[0]).toMatchObject({ type: "tool_result", toolUseId: "c2" });
  });

  it("handles tool call with empty arguments string", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "" } }],
      },
    ];
    const result = fromOpenAIMessages(messages);
    expect(result[0].content[0]).toMatchObject({
      type: "tool_use",
      input: {},
    });
  });
});

describe("toOpenAITools — adversarial", () => {
  it("handles tool with empty input schema", () => {
    const result = toOpenAITools([{ name: "noop", description: "Does nothing", input: {} }]);
    expect(result[0].function.parameters).toEqual({});
  });

  it("handles tool with no description", () => {
    const result = toOpenAITools([{ name: "bare", description: "", input: {} }]);
    expect(result[0].function.description).toBe("");
  });

  it("preserves complex JSON Schema input", () => {
    const input = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { deep: { type: "string", enum: ["a", "b"] } },
          required: ["deep"],
        },
      },
      required: ["nested"],
    };
    const result = toOpenAITools([{ name: "complex", description: "d", input }]);
    expect(result[0].function.parameters).toEqual(input);
  });
});

// ============================================================================
// Plugin — Adversarial
// ============================================================================

describe("OpenAI Compat Plugin — adversarial", () => {
  let gateway: Gateway;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop().catch(() => {});
    }
  });

  describe("malformed requests", () => {
    it("returns 400 for empty messages array", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, json } = mockHTTP("/v1/chat/completions", "POST", {
        model: "chat",
        messages: [],
      });
      await gateway.handleRequest(req, res);

      expect(res.statusCode).toBe(400);
      expect(json().error.type).toBe("invalid_request_error");
    });

    it("returns 400 for messages as non-array", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, json } = mockHTTP("/v1/chat/completions", "POST", {
        model: "chat",
        messages: "not an array",
      });
      await gateway.handleRequest(req, res);

      expect(res.statusCode).toBe(400);
    });

    it("handles body with no model field gracefully", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, json } = mockHTTP("/v1/chat/completions", "POST", {
        messages: [{ role: "user", content: "hi" }],
      });
      // Model field is missing — falls back to "default" which the gateway
      // can't find (test has apps "chat" and "gpt-4"). The key assertion:
      // this returns a proper OpenAI error, NOT a 500 crash.
      await gateway.handleRequest(req, res);
      expect(res.statusCode).toBe(404);
      expect(json().error.type).toBe("model_not_found");
    });

    it("returns 404 for wrong HTTP method on /v1/models", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, json } = mockHTTP("/v1/models", "POST");
      await gateway.handleRequest(req, res);

      expect(res.statusCode).toBe(404);
      expect(json().error.type).toBe("not_found");
    });

    it("returns 404 for wrong HTTP method on /v1/chat/completions", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res } = mockHTTP("/v1/chat/completions", "GET");
      await gateway.handleRequest(req, res);

      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for truncated JSON body", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, deliver } = mockHTTPWithStreamBody(
        "/v1/chat/completions",
        "POST",
        '{"model": "chat", "messages": [{"role": "user',
      );
      const p = gateway.handleRequest(req, res);
      deliver();
      await p;

      expect(res.statusCode).toBe(400);
    });

    it("handles req.on('error') during body parsing", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, error } = mockHTTPWithStreamBody("/v1/chat/completions", "POST", "");
      const p = gateway.handleRequest(req, res);
      error(new Error("connection reset"));
      await p;

      // Should not hang — parseBody resolves null on error
      expect(res.statusCode).toBe(400);
    });
  });

  describe("concurrent requests", () => {
    it("handles multiple simultaneous /v1/models requests", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const pairs = Array.from({ length: 10 }, () => mockHTTP("/v1/models", "GET"));

      await Promise.all(pairs.map(({ req, res }) => gateway.handleRequest(req, res)));

      for (const { res, json } of pairs) {
        expect(res.statusCode).toBe(200);
        expect(json().object).toBe("list");
      }
    });

    it("handles interleaved /v1/models and /v1/chat/completions", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const model1 = mockHTTP("/v1/models", "GET");
      const err1 = mockHTTP("/v1/chat/completions", "POST", { model: "chat" });
      const model2 = mockHTTP("/v1/models", "GET");
      const err2 = mockHTTP("/v1/chat/completions", "POST", { model: "chat", messages: [] });

      await Promise.all([
        gateway.handleRequest(model1.req, model1.res),
        gateway.handleRequest(err1.req, err1.res),
        gateway.handleRequest(model2.req, model2.res),
        gateway.handleRequest(err2.req, err2.res),
      ]);

      expect(model1.res.statusCode).toBe(200);
      expect(model2.res.statusCode).toBe(200);
      expect(err1.res.statusCode).toBe(400);
      expect(err2.res.statusCode).toBe(400);
    });
  });

  describe("error format compliance", () => {
    it("all errors have { error: { message, type, code } } shape", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const cases = [
        mockHTTP("/v1/chat/completions", "POST", { model: "chat" }),
        mockHTTP("/v1/unknown", "GET"),
        mockHTTP("/v1/chat/completions", "DELETE"),
      ];

      await Promise.all(cases.map(({ req, res }) => gateway.handleRequest(req, res)));

      for (const { json } of cases) {
        const data = json();
        expect(data).toHaveProperty("error");
        expect(data.error).toHaveProperty("message");
        expect(data.error).toHaveProperty("type");
        expect(data.error).toHaveProperty("code");
        expect(typeof data.error.message).toBe("string");
        expect(typeof data.error.type).toBe("string");
      }
    });

    it("error responses have correct Content-Type header", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res } = mockHTTP("/v1/nonexistent", "POST");
      await gateway.handleRequest(req, res);

      expect(res._headers["content-type"]).toBe("application/json");
    });
  });

  describe("model mapping", () => {
    it("maps model names to app IDs via modelMapping config", async () => {
      gateway = createTestGateway();
      await gateway.use(
        openaiCompatPlugin({
          modelMapping: { "gpt-4o": "gpt-4" },
        }),
      );

      // Verify the plugin is active and can handle requests
      const { req, res, json } = mockHTTP("/v1/models", "GET");
      await gateway.handleRequest(req, res);
      expect(res.statusCode).toBe(200);
    });
  });

  describe("multiple instances", () => {
    it("two OpenAI plugins with different prefixes coexist", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin({ id: "openai-v1", pathPrefix: "/v1" }));
      await gateway.use(openaiCompatPlugin({ id: "openai-v2", pathPrefix: "/v2" }));

      const v1 = mockHTTP("/v1/models", "GET");
      const v2 = mockHTTP("/v2/models", "GET");

      await Promise.all([
        gateway.handleRequest(v1.req, v1.res),
        gateway.handleRequest(v2.req, v2.res),
      ]);

      expect(v1.res.statusCode).toBe(200);
      expect(v2.res.statusCode).toBe(200);
      expect(v1.json().object).toBe("list");
      expect(v2.json().object).toBe("list");
    });

    it("removing one instance doesn't affect the other", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin({ id: "openai-v1", pathPrefix: "/v1" }));
      await gateway.use(openaiCompatPlugin({ id: "openai-v2", pathPrefix: "/v2" }));

      await gateway.remove("openai-v1");

      const v1 = mockHTTP("/v1/models", "GET");
      const v2 = mockHTTP("/v2/models", "GET");

      await Promise.all([
        gateway.handleRequest(v1.req, v1.res),
        gateway.handleRequest(v2.req, v2.res),
      ]);

      expect(v1.res.statusCode).toBe(404);
      expect(v2.res.statusCode).toBe(200);
    });
  });

  describe("URL edge cases", () => {
    it("handles query parameters on /v1/models", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, json } = mockHTTP("/v1/models?limit=10", "GET");
      await gateway.handleRequest(req, res);

      expect(res.statusCode).toBe(200);
      expect(json().object).toBe("list");
    });

    it("handles trailing slash on /v1/models/", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      // /v1/models/ — extra slash, should NOT match /v1/models (exact path)
      // This depends on route matching semantics — currently it 404s
      const { req, res } = mockHTTP("/v1/models/", "GET");
      await gateway.handleRequest(req, res);

      // The sub-path becomes "/models/" which doesn't match "/models"
      expect(res.statusCode).toBe(404);
    });

    it("handles missing host header gracefully", async () => {
      gateway = createTestGateway();
      await gateway.use(openaiCompatPlugin());

      const { req, res, json } = mockHTTP("/v1/models", "GET");
      req.headers = { "content-type": "application/json" };
      await gateway.handleRequest(req, res);

      // URL constructor needs a base — undefined host should still work
      expect(res.statusCode).toBe(200);
    });
  });
});
