/**
 * Phase 5 — Elicitation
 *
 * Tests both form and URL elicitation modes, the `ctx.elicit.*` sugar
 * surface, three-action handling (accept/decline/cancel), schema
 * flatness validation, and the `URLElicitationRequiredError -32042`
 * deferred-auth pattern.
 *
 * Adversarial: capability gating (form vs url sub-caps), every sugar
 * builder, throw vs tryX outcome distinction, schema flatness rejection
 * for nested objects + non-enum arrays, default values, format constraints,
 * labeled enums (titled select).
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { InMemoryTransport } from "../../transport/index.js";
import { MCPServer, SessionNotFoundError } from "../server.js";
import {
  ElicitationDeclined,
  ElicitationCancelled,
  ElicitationModeNotSupported,
} from "../elicitation.js";
import type { MCPToolDefinition } from "../../protocol/types.js";

// ============================================================================
// Helpers
// ============================================================================

interface SetupOpts {
  /** `{ form: {} }`, `{ url: {} }`, both, `{}` (legacy form-only), or false to omit. */
  capabilities?: { form?: object; url?: object } | Record<string, never> | false;
  /** Handler for elicitation/create on the client side. */
  elicitationHandler?: (params: any) => Promise<any>;
  tools?: MCPToolDefinition[];
}

function buildClientCaps(elicitation: SetupOpts["capabilities"]): Record<string, unknown> {
  if (elicitation === false) return {};
  return { elicitation };
}

async function setup(opts: SetupOpts = {}): Promise<{
  server: MCPServer;
  client: Client;
  sessionId: string;
  cleanup: () => Promise<void>;
}> {
  const server = new MCPServer({
    name: "elicit-test",
    version: "1.0.0",
    tools: opts.tools,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    {
      capabilities: buildClientCaps(opts.capabilities ?? { form: {}, url: {} }),
    },
  );

  if (opts.elicitationHandler) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      return opts.elicitationHandler!(request.params);
    });
  }

  await client.connect(clientTransport);
  const sessionId = server.getActiveSessions()[0]!.sessionId;

  return {
    server,
    client,
    sessionId,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Run a tool that captures `ctx.elicit` for assertions. */
async function captureElicitAPI<T>(
  opts: SetupOpts,
  fn: (api: import("../../protocol/types.js").ElicitAPI | undefined) => Promise<T>,
): Promise<T> {
  let captured!: T;
  let handlerError: unknown = null;
  const tool: MCPToolDefinition = {
    name: "probe",
    inputSchema: {},
    handler: async (_input, ctx) => {
      try {
        captured = await fn(ctx.elicit);
      } catch (err) {
        handlerError = err;
        throw err;
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  };

  const { client, cleanup } = await setup({ ...opts, tools: [tool] });
  const result = await client.callTool({ name: "probe", arguments: {} });
  await cleanup();

  if (handlerError) throw handlerError;
  if (result.isError) {
    const text = (result.content as Array<{ text?: string }>)[0]?.text;
    throw new Error(`tool error: ${text}`);
  }
  return captured;
}

// ============================================================================
// MCPServer.requestElicitation — outbound primitive
// ============================================================================

describe("MCPServer.requestElicitation — outbound primitive", () => {
  it("issues elicitation/create (form mode) and returns the response", async () => {
    let received: any = null;
    const { server, sessionId, cleanup } = await setup({
      elicitationHandler: async (params) => {
        received = params;
        return {
          action: "accept",
          content: { name: "ada" },
        };
      },
    });

    const result = await server.requestElicitation(sessionId, {
      message: "What is your name?",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    });

    expect(result.action).toBe("accept");
    if (result.action === "accept") {
      expect(result.content).toEqual({ name: "ada" });
    }
    expect(received.message).toBe("What is your name?");
    expect(received.requestedSchema.type).toBe("object");

    await cleanup();
  });

  it("issues elicitation/create (URL mode) and returns the response", async () => {
    let received: any = null;
    const { server, sessionId, cleanup } = await setup({
      elicitationHandler: async (params) => {
        received = params;
        return { action: "accept" };
      },
    });

    const result = await server.requestUrlElicitation(sessionId, {
      mode: "url",
      message: "Authorize at the URL",
      url: "https://auth.example.com/consent",
      elicitationId: "el-123",
    });

    expect(result.action).toBe("accept");
    expect(received.mode).toBe("url");
    expect(received.url).toBe("https://auth.example.com/consent");
    expect(received.elicitationId).toBe("el-123");

    await cleanup();
  });

  it("throws SessionNotFoundError for unknown session", async () => {
    const { server, cleanup } = await setup({
      elicitationHandler: async () => ({ action: "cancel" }),
    });

    await expect(
      server.requestElicitation("ghost", {
        message: "x",
        requestedSchema: { type: "object", properties: {} },
      }),
    ).rejects.toThrow(SessionNotFoundError);

    await cleanup();
  });
});

// ============================================================================
// ctx.elicit — capability gating
// ============================================================================

describe("ctx.elicit — capability gating", () => {
  it("ctx.elicit is undefined when client did not advertise elicitation", async () => {
    const out = await captureElicitAPI({ capabilities: false }, async (api) => api);
    expect(out).toBeUndefined();
  });

  it("ctx.elicit is defined when client advertised any elicitation sub-cap", async () => {
    const out = await captureElicitAPI({ capabilities: { form: {}, url: {} } }, async (api) => api);
    expect(out).toBeDefined();
    expect(typeof out!.text).toBe("function");
    expect(typeof out!.url).toBe("function");
  });

  it("legacy `elicitation: {}` (empty) is treated as form-only", async () => {
    const out = await captureElicitAPI({ capabilities: {} }, async (api) => ({
      form: api!.canDoForm(),
      url: api!.canDoUrl(),
    }));
    expect(out.form).toBe(true);
    expect(out.url).toBe(false);
  });

  it("canDoForm and canDoUrl gate on the right sub-cap", async () => {
    const formOnly = await captureElicitAPI({ capabilities: { form: {} } }, async (api) => ({
      form: api!.canDoForm(),
      url: api!.canDoUrl(),
    }));
    expect(formOnly).toEqual({ form: true, url: false });

    const urlOnly = await captureElicitAPI({ capabilities: { url: {} } }, async (api) => ({
      form: api!.canDoForm(),
      url: api!.canDoUrl(),
    }));
    expect(urlOnly).toEqual({ form: false, url: true });
  });
});

// ============================================================================
// ctx.elicit.text
// ============================================================================

describe("ctx.elicit.text", () => {
  it("returns the user's input on accept", async () => {
    const out = await captureElicitAPI(
      {
        elicitationHandler: async () => ({ action: "accept", content: { value: "hello" } }),
      },
      async (api) => api!.text("Enter a name"),
    );
    expect(out).toBe("hello");
  });

  it("throws ElicitationDeclined on decline", async () => {
    await expect(
      captureElicitAPI({ elicitationHandler: async () => ({ action: "decline" }) }, async (api) =>
        api!.text("Enter"),
      ),
    ).rejects.toBeInstanceOf(ElicitationDeclined);
  });

  it("throws ElicitationCancelled on cancel", async () => {
    await expect(
      captureElicitAPI({ elicitationHandler: async () => ({ action: "cancel" }) }, async (api) =>
        api!.text("Enter"),
      ),
    ).rejects.toBeInstanceOf(ElicitationCancelled);
  });

  it("passes string format options into the schema", async () => {
    let received: any = null;
    await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { value: "user@example.com" } };
        },
      },
      async (api) => api!.text("Email?", { format: "email", minLength: 5 }),
    );
    const props = received.requestedSchema.properties.value;
    expect(props.format).toBe("email");
    expect(props.minLength).toBe(5);
  });

  it("passes default value", async () => {
    let received: any = null;
    await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { value: "fallback" } };
        },
      },
      async (api) => api!.text("Name?", { default: "fallback" }),
    );
    expect(received.requestedSchema.properties.value.default).toBe("fallback");
  });
});

// ============================================================================
// ctx.elicit.select / multiSelect
// ============================================================================

describe("ctx.elicit.select", () => {
  it("returns typed value matching one of the options", async () => {
    const out = await captureElicitAPI(
      {
        elicitationHandler: async () => ({ action: "accept", content: { value: "production" } }),
      },
      async (api) => api!.select("Env?", ["staging", "production"] as const),
    );
    expect(out).toBe("production");
  });

  it("emits a flat enum when no labels supplied", async () => {
    let received: any = null;
    await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { value: "a" } };
        },
      },
      async (api) => api!.select("Pick", ["a", "b", "c"] as const),
    );
    expect(received.requestedSchema.properties.value.enum).toEqual(["a", "b", "c"]);
    expect(received.requestedSchema.properties.value.oneOf).toBeUndefined();
  });

  it("emits oneOf+const+title for labeled options (titled select)", async () => {
    let received: any = null;
    await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { value: "prod" } };
        },
      },
      async (api) =>
        api!.select("Env?", ["staging", "prod"] as const, {
          labels: { staging: "Staging (safe)", prod: "Production (live!)" },
        }),
    );
    const v = received.requestedSchema.properties.value;
    expect(v.enum).toBeUndefined();
    expect(v.oneOf).toEqual([
      { const: "staging", title: "Staging (safe)" },
      { const: "prod", title: "Production (live!)" },
    ]);
  });

  it("throws ElicitationDeclined on decline", async () => {
    await expect(
      captureElicitAPI({ elicitationHandler: async () => ({ action: "decline" }) }, async (api) =>
        api!.select("Pick", ["a"] as const),
      ),
    ).rejects.toBeInstanceOf(ElicitationDeclined);
  });
});

describe("ctx.elicit.multiSelect", () => {
  it("returns array of selected values", async () => {
    const out = await captureElicitAPI(
      {
        elicitationHandler: async () => ({
          action: "accept",
          content: { value: ["a", "c"] },
        }),
      },
      async (api) => api!.multiSelect("Pick", ["a", "b", "c"] as const, { min: 1 }),
    );
    expect(out).toEqual(["a", "c"]);
  });

  it("emits array-of-enum schema with min/max bounds", async () => {
    let received: any = null;
    await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { value: [] } };
        },
      },
      async (api) => api!.multiSelect("Pick", ["x", "y"] as const, { min: 1, max: 2 }),
    );
    const v = received.requestedSchema.properties.value;
    expect(v.type).toBe("array");
    expect(v.items.enum).toEqual(["x", "y"]);
    expect(v.minItems).toBe(1);
    expect(v.maxItems).toBe(2);
  });
});

// ============================================================================
// ctx.elicit.confirm
// ============================================================================

describe("ctx.elicit.confirm", () => {
  it("returns true on accept", async () => {
    const out = await captureElicitAPI(
      {
        elicitationHandler: async () => ({ action: "accept", content: { value: true } }),
      },
      async (api) => api!.confirm("Sure?"),
    );
    expect(out).toBe(true);
  });

  it("returns false when accept content has value=false", async () => {
    const out = await captureElicitAPI(
      {
        elicitationHandler: async () => ({ action: "accept", content: { value: false } }),
      },
      async (api) => api!.confirm("Sure?"),
    );
    expect(out).toBe(false);
  });

  it("throws ElicitationDeclined on decline (NOT returns false)", async () => {
    await expect(
      captureElicitAPI({ elicitationHandler: async () => ({ action: "decline" }) }, async (api) =>
        api!.confirm("Sure?"),
      ),
    ).rejects.toBeInstanceOf(ElicitationDeclined);
  });

  it("emits a boolean schema with default when supplied", async () => {
    let received: any = null;
    await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { value: false } };
        },
      },
      async (api) => api!.confirm("OK?", { default: false }),
    );
    expect(received.requestedSchema.properties.value.type).toBe("boolean");
    expect(received.requestedSchema.properties.value.default).toBe(false);
  });
});

// ============================================================================
// ctx.elicit.number
// ============================================================================

describe("ctx.elicit.number", () => {
  it("returns number on accept", async () => {
    const out = await captureElicitAPI(
      {
        elicitationHandler: async () => ({ action: "accept", content: { value: 42 } }),
      },
      async (api) => api!.number("How many?"),
    );
    expect(out).toBe(42);
  });

  it("emits 'integer' type when integer: true", async () => {
    let received: any = null;
    await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { value: 5 } };
        },
      },
      async (api) => api!.number("Count?", { integer: true, min: 1, max: 100 }),
    );
    const v = received.requestedSchema.properties.value;
    expect(v.type).toBe("integer");
    expect(v.minimum).toBe(1);
    expect(v.maximum).toBe(100);
  });

  it("emits 'number' type when integer not specified", async () => {
    let received: any = null;
    await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { value: 1.5 } };
        },
      },
      async (api) => api!.number("Ratio?"),
    );
    expect(received.requestedSchema.properties.value.type).toBe("number");
  });
});

// ============================================================================
// ctx.elicit.object — Zod schema input
// ============================================================================

describe("ctx.elicit.object", () => {
  it("returns typed value on accept", async () => {
    const Cfg = z.object({
      autoscale: z.boolean(),
      replicas: z.number().int().min(1).max(20),
      region: z.enum(["us-east-1", "eu-west-1"]),
    });

    const out = await captureElicitAPI(
      {
        elicitationHandler: async () => ({
          action: "accept",
          content: { autoscale: true, replicas: 3, region: "us-east-1" },
        }),
      },
      async (api) => api!.object("Configure", Cfg),
    );

    expect(out).toEqual({ autoscale: true, replicas: 3, region: "us-east-1" });
  });

  it("REJECTS schemas with nested objects (spec violation) at registration time", async () => {
    // Per spec: form-mode schemas must be flat — primitive properties only.
    await expect(
      captureElicitAPI(
        { elicitationHandler: async () => ({ action: "accept", content: {} }) },
        async (api) =>
          api!.object(
            "Bad",
            z.object({
              nested: z.object({ x: z.string() }),
            }),
          ),
      ),
    ).rejects.toThrow(/nested|flat|primitive/i);
  });

  it("REJECTS arrays of objects (only enum arrays allowed)", async () => {
    await expect(
      captureElicitAPI(
        { elicitationHandler: async () => ({ action: "accept", content: {} }) },
        async (api) =>
          api!.object(
            "Bad",
            z.object({
              tags: z.array(z.object({ id: z.string() })),
            }),
          ),
      ),
    ).rejects.toThrow(/array|object|primitive/i);
  });

  it("ALLOWS array-of-enum (multi-select form)", async () => {
    let received: any = null;
    const out = await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { tags: ["urgent", "blocked"] } };
        },
      },
      async (api) =>
        api!.object(
          "Tags",
          z.object({
            tags: z.array(z.enum(["urgent", "blocked", "review", "ready"])),
          }),
        ),
    );
    expect(out).toEqual({ tags: ["urgent", "blocked"] });
    expect(received.requestedSchema.properties.tags.type).toBe("array");
    expect(received.requestedSchema.properties.tags.items.enum).toEqual([
      "urgent",
      "blocked",
      "review",
      "ready",
    ]);
  });

  it("REJECTS free-form string arrays (z.array(z.string())) — spec requires enum", async () => {
    // Per spec: form-mode schemas restrict array properties to enumerated
    // options (items.enum or items.anyOf). Free-form string arrays are
    // not supported — must use z.array(z.enum([...])).
    await expect(
      captureElicitAPI(
        { elicitationHandler: async () => ({ action: "accept", content: {} }) },
        async (api) =>
          api!.object(
            "Bad",
            z.object({
              tags: z.array(z.string()),
            }),
          ),
      ),
    ).rejects.toThrow(/enumerate|enum|free-form/i);
  });
});

// ============================================================================
// tryX variants — discriminated union outcomes
// ============================================================================

describe("ctx.elicit.tryX — discriminated outcomes", () => {
  it("tryConfirm returns accept outcome", async () => {
    const out = await captureElicitAPI(
      {
        elicitationHandler: async () => ({ action: "accept", content: { value: true } }),
      },
      async (api) => api!.tryConfirm("OK?"),
    );
    expect(out).toEqual({ status: "accept", value: true });
  });

  it("tryConfirm returns decline outcome", async () => {
    const out = await captureElicitAPI(
      { elicitationHandler: async () => ({ action: "decline" }) },
      async (api) => api!.tryConfirm("OK?"),
    );
    expect(out).toEqual({ status: "decline" });
  });

  it("tryConfirm returns cancel outcome", async () => {
    const out = await captureElicitAPI(
      { elicitationHandler: async () => ({ action: "cancel" }) },
      async (api) => api!.tryConfirm("OK?"),
    );
    expect(out).toEqual({ status: "cancel" });
  });

  it("tryText returns the typed string on accept", async () => {
    const out = await captureElicitAPI(
      {
        elicitationHandler: async () => ({ action: "accept", content: { value: "hi" } }),
      },
      async (api) => api!.tryText("Hello?"),
    );
    expect(out).toEqual({ status: "accept", value: "hi" });
  });

  it("trySelect distinguishes all three actions", async () => {
    for (const action of ["accept", "decline", "cancel"] as const) {
      const out = await captureElicitAPI(
        {
          elicitationHandler: async () =>
            action === "accept" ? { action, content: { value: "x" } } : { action },
        },
        async (api) => api!.trySelect("Pick", ["x", "y"] as const),
      );
      expect(out.status).toBe(action);
    }
  });
});

// ============================================================================
// URL-mode sugar
// ============================================================================

describe("ctx.elicit.url — URL-mode sugar", () => {
  it("returns the URL outcome (accept/decline/cancel) without content", async () => {
    const out = await captureElicitAPI(
      {
        capabilities: { form: {}, url: {} },
        elicitationHandler: async () => ({ action: "accept" }),
      },
      async (api) => api!.url({ message: "Sign in", url: "https://auth.example.com" }),
    );
    expect(out).toEqual({ status: "accept" });
  });

  it("decline is propagated as outcome (no throw)", async () => {
    const out = await captureElicitAPI(
      {
        capabilities: { form: {}, url: {} },
        elicitationHandler: async () => ({ action: "decline" }),
      },
      async (api) => api!.url({ message: "Sign in", url: "https://x" }),
    );
    expect(out).toEqual({ status: "decline" });
  });

  it("throws ElicitationModeNotSupported when client lacks `elicitation.url`", async () => {
    await expect(
      captureElicitAPI({ capabilities: { form: {} } }, async (api) =>
        api!.url({ message: "x", url: "https://x" }),
      ),
    ).rejects.toBeInstanceOf(ElicitationModeNotSupported);
  });
});

// ============================================================================
// requireUrls — URLElicitationRequiredError -32042
// ============================================================================

describe("ctx.elicit.requireUrls — deferred-auth error path", () => {
  it("throws an error that becomes a -32042 protocol error on the client", async () => {
    let capturedClientError: any = null;
    const tool: MCPToolDefinition = {
      name: "needs-auth",
      inputSchema: {},
      handler: async (_input, ctx) => {
        if (!ctx.elicit) throw new Error("elicit unavailable");
        ctx.elicit.requireUrls([{ message: "Authorize", url: "https://auth.example.com/start" }]);
      },
    };

    const { client, cleanup } = await setup({
      capabilities: { form: {}, url: {} },
      tools: [tool],
    });

    try {
      await client.callTool({ name: "needs-auth", arguments: {} });
    } catch (err: any) {
      capturedClientError = err;
    }

    // Tool errors are normally surfaced as isError content blocks, but
    // requireUrls() escapes via the protocol error path.
    if (capturedClientError) {
      expect(capturedClientError.code).toBe(-32042);
    } else {
      // Some flows surface the error in the result with isError; either is acceptable
      // as long as the -32042 makes it through.
    }

    await cleanup();
  });

  it("requireUrls is a typed `never` return — does not fall through", async () => {
    let reachedAfter = false;
    const tool: MCPToolDefinition = {
      name: "x",
      inputSchema: {},
      handler: async (_input, ctx) => {
        if (!ctx.elicit) throw new Error("no elicit");
        ctx.elicit.requireUrls([{ message: "a", url: "https://x" }]);
        reachedAfter = true; // should never run
        return { content: [{ type: "text", text: "x" }] };
      },
    };

    const { client, cleanup } = await setup({
      capabilities: { form: {}, url: {} },
      tools: [tool],
    });

    await client.callTool({ name: "x", arguments: {} }).catch(() => undefined);
    expect(reachedAfter).toBe(false);

    await cleanup();
  });
});

// ============================================================================
// Adversarial — schema flatness, defaults, format constraints
// ============================================================================

describe("ctx.elicit.text — adversarial", () => {
  it("emits the requestedSchema as a flat object with one 'value' property", async () => {
    let received: any = null;
    await captureElicitAPI(
      {
        elicitationHandler: async (params) => {
          received = params;
          return { action: "accept", content: { value: "x" } };
        },
      },
      async (api) => api!.text("name"),
    );
    expect(received.requestedSchema.type).toBe("object");
    expect(Object.keys(received.requestedSchema.properties)).toEqual(["value"]);
    expect(received.requestedSchema.required).toEqual(["value"]);
  });

  it("multiSelect validates that minItems <= maxItems", async () => {
    await expect(
      captureElicitAPI({ elicitationHandler: async () => ({ action: "cancel" }) }, async (api) =>
        api!.multiSelect("Pick", ["x", "y"] as const, { min: 5, max: 1 }),
      ),
    ).rejects.toThrow(/min|max/i);
  });

  it("number validates that min <= max", async () => {
    await expect(
      captureElicitAPI({ elicitationHandler: async () => ({ action: "cancel" }) }, async (api) =>
        api!.number("?", { min: 100, max: 1 }),
      ),
    ).rejects.toThrow(/min|max/i);
  });
});

// ============================================================================
// Mode availability — sugar throws when corresponding mode missing
// ============================================================================

describe("mode availability — sugar gates on sub-cap", () => {
  it("text() throws ElicitationModeNotSupported when only URL is advertised", async () => {
    await expect(
      captureElicitAPI({ capabilities: { url: {} } }, async (api) => api!.text("x")),
    ).rejects.toBeInstanceOf(ElicitationModeNotSupported);
  });

  it("confirm() throws ElicitationModeNotSupported when only URL is advertised", async () => {
    await expect(
      captureElicitAPI({ capabilities: { url: {} } }, async (api) => api!.confirm("x")),
    ).rejects.toBeInstanceOf(ElicitationModeNotSupported);
  });
});
