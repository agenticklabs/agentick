/**
 * `runMcpConformance` — the executable MCP conformance suite.
 *
 * MCP is the most protocol-heavy harness in the workspace, yet it long
 * lacked the parameterized conformance suite that eight sibling
 * harnesses ship (`timeline`, `state`, `knobs`, `skills`, `cluster`,
 * `credentials`, `tasks`, `elicitation`). This module fills that gap
 * and is the FINALIZER/VERIFIER track: it grows per-capability as
 * later waves land. Adding a capability = adding a section here, never
 * a rewrite.
 *
 * Three parts, mirroring how MCP is exercised in the wild:
 *
 *   Part A — LOOPBACK. A real {@link McpServerHarness} ↔ a real
 *     {@link McpClientHarness} over the linked in-memory transport
 *     (`InMemoryMcpTransport.createLinkedPair`, via the harness's own
 *     `inMemoryServerTransport` listener). Both roles live in this
 *     package; both wrap the same `@modelcontextprotocol/sdk`. Drives
 *     every landed capability through OUR translation layers on both
 *     sides. No fakes — real transport, real harnesses, real substrate
 *     (only the "model" is scripted, and only via direct verb calls).
 *
 *   Part B — REAL-PEER. Two halves:
 *       B1 (always available): the raw SDK reference `Client` drives
 *          OUR server harness. The SDK Client applies NO agentick
 *          client-side normalization, so it exercises the pure wire
 *          shape our server emits — and it exposes verbs our client
 *          harness doesn't (`resources/subscribe`, `ping`).
 *       B2 (gated, skips cleanly when absent): the SDK reference
 *          server `@modelcontextprotocol/server-everything` drives OUR
 *          client harness over stdio. This is the ONLY thing that
 *          catches wire-shape drift the shared-SDK loopback can't —
 *          both loopback sides share the SDK, so a mutual bug passes.
 *
 *   Part C — VERSION MATRIX. The Part A loopback re-run against BOTH
 *     `draft` and `2025-11-25` client eras (via the era codec), proving
 *     version normalization stays stable. See the note in
 *     {@link eraCodecNormalizationSection} on why this is a forward
 *     guard today.
 *
 * @see docs/proposals/v2/blueprint/23-mcp-as-harness.md
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md
 * @see docs/proposals/v2/blueprint/62-resources-harness.md
 */

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Stream } from "effect";

import { Client as SdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  PingRequestSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type {
  ContentBlock,
  ElicitationHarnessProtocol,
  EventBus,
  McpRequestContext,
  MessageEntry,
  MessageInbox,
  OperationJournal,
  Prompts,
  Resources,
  ResourceContents,
  ToolDeclaration,
} from "@agentick/spec";
import { jsonSchema } from "@agentick/spec";
import { createTool, createToolCatalog, type MutableToolCatalog } from "@agentick/tool";
import { ELICITATION_CHANNEL_FQN } from "@agentick/elicitation";

import { McpClientHarness, NoneAuth, selectCodec, type McpSpecEra } from "../client/index.js";
import {
  completeFromList,
  inMemoryServerTransport,
  McpServerHarness,
  type ResourcesFilter,
  type ToolHandlerResolver,
} from "../server/index.js";

// ============================================================================
// Caller-supplied harness factories (dependency inversion)
// ============================================================================

/**
 * The suite drives REAL sibling harnesses but does NOT import their
 * concrete classes — that would force `@agentick/resources` (which
 * no `@agentick/mcp` SOURCE constructs — the server PROJECTS the
 * `Resources` spec interface via config, it never owns one) into
 * @agentick/mcp's runtime dependency graph. Instead the caller injects
 * factories, exactly like `runTimelineStoreConformance` /
 * `runSandboxProviderConformance` take a `factory`. The caller's
 * `*.spec.ts` (a test, so a devDependency edge) imports the concrete
 * `ResourcesHarness` / `PromptsHarness` / `ElicitationHarness` and hands
 * them in.
 *
 * Each factory returns a REAL, ready harness (the factory awaits
 * `ready`). Suites register fixtures on the returned instance through
 * the spec-interface mutators (`register` / `registerTemplate` /
 * `notifyUpdated`) — no concrete type escapes into this module.
 */
export interface McpConformanceFactories {
  /**
   * Fresh {@link Resources} source on its own in-memory substrate. The
   * suite registers the canonical resource fixtures on it.
   */
  makeResources(): Promise<Resources>;
  /**
   * Fresh {@link Prompts} source on its own in-memory substrate. The
   * suite registers the canonical prompt fixtures on it.
   */
  makePrompts(): Promise<Prompts>;
  /**
   * Client-side elicitation harness SHARING the client's substrate
   * (`journal` / `bus` / `inbox`) so the SDK elicit handler's
   * `inbox.send(elicitAddress, …)` reaches it and its bus publications
   * reach the suite's auto-responder. Construct it with exactly the
   * passed substrate (the `BaseHarness` constructor signature).
   */
  makeElicitation(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
  ): Promise<ElicitationHarnessProtocol>;
}

// ============================================================================
// Options
// ============================================================================

export interface McpConformanceOptions {
  /** Suite label appended to the top-level `describe` heading. */
  readonly label?: string;
  /**
   * Skip the whole suite (registers it as skipped, never constructs
   * harnesses). Threaded as an option — not an `if` at the call site —
   * so the gate stays out of the test bodies the linter forbids.
   */
  readonly skip?: boolean;
  /**
   * Per-capability section gates for capabilities that are DESIGNED but
   * NOT YET WIRED end-to-end. Each defaults to skipped; flip to `true`
   * once the capability lands so its section runs green. This is the
   * "new capability = new section" seam.
   */
  readonly sections?: {
    /**
     * Server→client sampling loopback. NOT landed: the server harness
     * advertises `sampling: false` (no `SamplingHarness` yet), so our
     * server cannot initiate `sampling/createMessage`. Client-side
     * INBOUND sampling (adopter `samplingHandler`) IS landed and is
     * covered by `wave2-client.spec.ts`. Defaults skipped.
     */
    readonly sampling?: boolean;
  };
}

// ============================================================================
// Canonical fixtures — the contract the loopback + refclient assert against
// ============================================================================

const echoSchema = jsonSchema({
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
});
const emptySchema = jsonSchema({ type: "object", properties: {} });

/** A plain tool declaration for the catalog form (handlers resolve by ref). */
function decl(name: string, description: string, inputSchema = emptySchema): ToolDeclaration {
  return {
    id: name,
    name,
    description,
    inputSchema,
    exposure: ["model"],
    handlerRef: `handler:${name}`,
  };
}

function textEntries(text: string): readonly MessageEntry[] {
  return [{ kind: "message", role: "user", content: [{ type: "text", text }] }];
}

/** Resource-contents literal for the ResourcesHarness resolvers. */
function textResource(uri: string, body: string): ResourceContents {
  return { uri, mimeType: "text/plain", text: body };
}

/**
 * The canonical loopback server: every landed server capability wired
 * at once so a single connection exercises the whole surface.
 *
 *   - tools:   a LIVE {@link MutableToolCatalog} (echo / ask_name /
 *              ask_consent / emit_logs) so `tools/list_changed` is
 *              reachable via `catalog.register/remove`.
 *   - prompts: a real {@link PromptsHarness} (`greet` with an argument).
 *   - resources: a real {@link ResourcesHarness} (fixed text + blob, a
 *              template, and a `watched` resource for subscribe/updated).
 *   - completion: `greet.name` prefix-completes from a fixed list.
 *   - elicit:  ON — `ask_name` (form) + `ask_consent` (url) call
 *              `ctx.elicit.*`.
 *   - logging: ON — `emit_logs` fires an info + a debug line.
 */
interface CanonicalServer {
  readonly harness: McpServerHarness;
  readonly transport: ReturnType<typeof inMemoryServerTransport>;
  readonly catalog: MutableToolCatalog;
  readonly prompts: Prompts;
  readonly resources: Resources;
  close(): Promise<void>;
}

async function makeCanonicalServer(
  factories: McpConformanceFactories,
  options: { readonly resourcesFilter?: ResourcesFilter } = {},
): Promise<CanonicalServer> {
  const prompts = await factories.makePrompts();
  await prompts.register({
    declaration: {
      name: "greet",
      description: "Greet someone by name",
      arguments: [{ name: "name", description: "who to greet", required: true }],
      render: (args) => textEntries(`Hello, ${(args as { name: string }).name}!`),
    },
  });

  const resources = await factories.makeResources();
  resources.register("mem://doc", () => [textResource("mem://doc", "hello world")], {
    name: "Doc",
    description: "a text document",
    mimeType: "text/plain",
  });
  resources.register("mem://bin", () => [
    { uri: "mem://bin", mimeType: "application/octet-stream", blob: "YmluYXJ5" },
  ]);
  resources.register("mem://watched", () => [textResource("mem://watched", "v1")]);
  resources.registerTemplate("mem://users/{id}", (uri) => [textResource(uri, `user:${uri}`)], {
    name: "User",
  });

  const catalog = createToolCatalog([
    decl("echo", "Echo the input back", echoSchema),
    decl("ask_name", "Ask the user their name via a form elicitation"),
    decl("ask_consent", "Ask the user to consent via a url elicitation"),
    decl("emit_logs", "Emit an info + a debug log line"),
  ]);

  const resolveHandler: ToolHandlerResolver = (ref) => {
    switch (ref) {
      case "handler:echo":
        return async (input) => ({
          kind: "inline",
          content: [{ type: "text", text: `echo: ${(input as { q: string }).q}` }],
        });
      case "handler:ask_name":
        return async (_input, ctx: McpRequestContext) => {
          const name = await ctx.elicit!.text("What is your name?");
          return { kind: "inline", content: [{ type: "text", text: name }] };
        };
      case "handler:ask_consent":
        return async (_input, ctx: McpRequestContext) => {
          await ctx.elicit!.url({ message: "Approve", url: "https://example.com/approve" });
          return { kind: "inline", content: [{ type: "text", text: "consented" }] };
        };
      case "handler:emit_logs":
        return async (_input, ctx: McpRequestContext) => {
          ctx.log?.("info", { msg: "info-line" }, "conf-logger");
          ctx.log?.("debug", { msg: "debug-line" });
          return { kind: "inline", content: [{ type: "text", text: "logged" }] };
        };
      default:
        return null;
    }
  };

  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "conformance-server",
      transports: [transport],
      tools: { registry: catalog, resolveHandler },
      prompts: { use: prompts },
      resources: {
        use: resources,
        ...(options.resourcesFilter ? { filter: options.resourcesFilter } : {}),
      },
      completions: { prompts: { greet: { name: completeFromList(["Ada", "Alan", "Bob"]) } } },
      elicit: true,
      serverInfo: { name: "conformance", version: "0.0.0" },
    },
  );
  await harness.ready;
  await harness.start();

  return {
    harness,
    transport,
    catalog,
    prompts,
    resources,
    close: async () => {
      await harness.close();
      await prompts.close();
      await resources.close();
    },
  };
}

// ============================================================================
// Loopback wiring — OUR client harness + a client-side ElicitationHarness
// ============================================================================

/**
 * Auto-responder for inbound elicitations. Subscribes to the shared
 * client bus, and for every published elicit request resolves it via
 * `respond()`:
 *   - form mode → `{ outcome: "accepted", value: { value: "Ada" } }`
 *   - url mode  → `{ outcome: "accepted" }` (consent only)
 *
 * Runs as a detached Effect fiber; the returned disposer interrupts it.
 */
function startElicitResponder(
  bus: EventBus,
  elicit: ElicitationHarnessProtocol,
): () => Promise<void> {
  const stream = bus.subscribe({ surface: "session", name: { exact: ELICITATION_CHANNEL_FQN } });
  const fiber = Effect.runFork(
    Stream.runForEach(stream, (env) =>
      Effect.promise(async () => {
        const meta = (env as { metadata?: { correlationId?: string } }).metadata;
        const correlationId = meta?.correlationId;
        if (typeof correlationId !== "string") return;
        const payload = (env as { payload?: { mode?: string } }).payload;
        if (payload?.mode === "url") {
          await elicit.respond({ correlationId, outcome: "accepted" });
        } else {
          await elicit.respond({ correlationId, outcome: "accepted", value: { value: "Ada" } });
        }
      }),
    ),
  );
  return () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined);
}

interface Loopback {
  readonly server: CanonicalServer;
  readonly client: McpClientHarness;
  readonly elicit: ElicitationHarnessProtocol;
  close(): Promise<void>;
}

/**
 * Stand up a full loopback: canonical server ↔ OUR client harness over
 * the linked in-memory transport, with a client-side
 * {@link ElicitationHarness} (sharing the client's substrate) + an
 * auto-responder so inbound `elicitation/create` requests resolve.
 *
 * `era` seeds the client's initial era codec. Note the harness RE-selects
 * the codec from the server's negotiated `protocolVersion` on connect;
 * because `selectCodec` currently maps every version to the draft
 * passthrough, the seeded era does not diverge behavior today — see
 * {@link eraCodecNormalizationSection}.
 */
async function makeLoopback(
  factories: McpConformanceFactories,
  era: McpSpecEra,
): Promise<Loopback> {
  const server = await makeCanonicalServer(factories);
  const clientTransport = await server.transport.connect();

  // Client + elicit harness share ONE substrate so the SDK elicit
  // handler's `inbox.send(elicitAddress, …)` reaches the elicit harness,
  // and the elicit harness's bus publications reach the auto-responder.
  const journal = new MemoryJournal({ capacity: 1024 });
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();

  const elicit = await factories.makeElicitation(`elicit:${generateId()}`, journal, bus, inbox);
  const stopResponder = startElicitResponder(bus, elicit);

  const client = new McpClientHarness(`mcp:${generateId()}`, journal, bus, inbox, {
    serverId: "loopback",
    transport: clientTransport,
    auth: new NoneAuth(),
    elicitAddress: elicit.address,
    codec: selectCodec(era),
    elicitTimeoutMs: 5_000,
  });
  await client.connect();

  return {
    server,
    client,
    elicit,
    close: async () => {
      await stopResponder();
      await client.close();
      await elicit.close();
      await server.close();
    },
  };
}

/** Poll helper — resolves once `predicate()` is true or times out. */
async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until(): timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ============================================================================
// Part A + C — loopback sections, parameterized by era
// ============================================================================

function loopbackSections(factories: McpConformanceFactories, era: McpSpecEra): void {
  describe(`Part A — loopback (our client ↔ our server) [era=${era}]`, () => {
    let lb: Loopback;
    beforeEach(async () => {
      lb = await makeLoopback(factories, era);
    });
    afterEach(async () => {
      await lb.close();
    });

    // ─── initialize + capability negotiation ───
    describe("initialize + negotiation", () => {
      it("reaches ready after the initialize handshake", () => {
        expect(lb.client.state).toBe("ready");
      });

      it("selects an era codec on connect", () => {
        // The harness re-selects from the negotiated protocolVersion;
        // `selectCodec` collapses all versions to the draft passthrough
        // today, so the era is always canonical post-connect. Pinned so a
        // future real 2025-11-25 codec makes this assertion meaningful.
        expect(lb.client.currentCodec().era).toBe("2026-07-28");
      });
    });

    // ─── tools ───
    describe("tools", () => {
      it("tools/list returns the advertised catalog", async () => {
        const { tools } = await lb.client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          "ask_consent",
          "ask_name",
          "echo",
          "emit_logs",
        ]);
      });

      it("tools/call dispatches to the resolved handler", async () => {
        const res = await lb.client.callTool("echo", { q: "hi" });
        expect(res.content).toEqual([{ type: "text", text: "echo: hi" }]);
        expect(res.isError).toBeFalsy();
      });

      it("tools/list_changed fires on catalog mutation; refetch reflects it", async () => {
        const events: string[] = [];
        lb.client.onListChanged((e) => events.push(e.kind));
        lb.server.catalog.register(decl("late", "added after connect", echoSchema));
        await until(() => events.includes("tools"));
        const { tools } = await lb.client.listTools();
        expect(tools.map((t) => t.name)).toContain("late");

        const before = events.filter((k) => k === "tools").length;
        lb.server.catalog.remove("late");
        await until(() => events.filter((k) => k === "tools").length > before);
        const after = await lb.client.listTools();
        expect(after.tools.map((t) => t.name)).not.toContain("late");
      });
    });

    // ─── prompts ───
    describe("prompts", () => {
      it("prompts/list returns registered prompts with arguments", async () => {
        const page = await lb.client.listPrompts();
        const greet = page.prompts.find((p) => p.name === "greet");
        expect(greet).toBeDefined();
        expect(greet!.arguments).toEqual([
          { name: "name", description: "who to greet", required: true },
        ]);
      });

      it("prompts/get renders messages with the supplied arguments", async () => {
        const result = await lb.client.getPrompt("greet", { name: "Ada" });
        expect(result.messages).toEqual([
          { role: "user", content: [{ type: "text", text: "Hello, Ada!" }] },
        ]);
      });

      it("prompts/list_changed fires on register", async () => {
        const events: string[] = [];
        lb.client.onListChanged((e) => events.push(e.kind));
        await lb.server.prompts.register({
          declaration: {
            name: "farewell",
            description: "Say goodbye",
            template: textEntries("Bye!"),
          },
        });
        await until(() => events.includes("prompts"));
        expect(events).toContain("prompts");
      });
    });

    // ─── resources ───
    describe("resources", () => {
      it("resources/list returns registered resources with metadata", async () => {
        const page = await lb.client.listResources();
        const doc = page.resources.find((r) => r.uri === "mem://doc");
        expect(doc).toMatchObject({ name: "Doc", mimeType: "text/plain" });
        expect(page.resources.map((r) => r.uri).sort()).toEqual([
          "mem://bin",
          "mem://doc",
          "mem://watched",
        ]);
      });

      it("resources/templates/list returns registered templates", async () => {
        const page = await lb.client.listResourceTemplates();
        expect(page.templates).toEqual([{ uriTemplate: "mem://users/{id}", name: "User" }]);
      });

      it("resources/read maps text contents", async () => {
        const contents = await lb.client.readResource("mem://doc");
        expect(contents).toEqual([
          { uri: "mem://doc", mimeType: "text/plain", text: "hello world" },
        ]);
      });

      it("resources/read maps blob contents", async () => {
        const contents = await lb.client.readResource("mem://bin");
        expect(contents).toEqual([
          { uri: "mem://bin", mimeType: "application/octet-stream", blob: "YmluYXJ5" },
        ]);
      });

      it("resources/read resolves a template with the concrete uri", async () => {
        const contents = await lb.client.readResource("mem://users/7");
        expect(contents).toEqual([
          { uri: "mem://users/7", mimeType: "text/plain", text: "user:mem://users/7" },
        ]);
      });

      it("resources/list_changed fires on register", async () => {
        const events: string[] = [];
        lb.client.onListChanged((e) => events.push(e.kind));
        lb.server.resources.register("mem://new", () => [textResource("mem://new", "n")]);
        await until(() => events.includes("resources"));
        expect(events).toContain("resources");
      });
    });

    // ─── completion ───
    describe("completion", () => {
      it("prompt-argument completion prefix-filters from the configured list", async () => {
        const result = await lb.client.completePromptArgument("greet", "name", "A");
        expect(result.values).toEqual(["Ada", "Alan"]);
      });

      it("resource-template completion returns empty (Wave 4 gap — pinned)", async () => {
        // Server-side resource-template completion is NOT wired (the
        // completions slot only carries `prompts`). The server returns
        // an empty value list for `ref/resource`; pinned so wiring it
        // later flips this to a positive assertion.
        const result = await lb.client.completeResourceTemplate("mem://users/{id}", "id", "4");
        expect(result.values).toEqual([]);
      });
    });

    // ─── logging ───
    describe("logging", () => {
      it("default level emits both info and debug from ctx.log", async () => {
        const received: string[] = [];
        lb.client.onLogMessage((m) => received.push(m.level));
        await lb.client.callTool("emit_logs", {});
        await until(() => received.length >= 2);
        expect(received.sort()).toEqual(["debug", "info"]);
      });

      it("setLoggingLevel('info') filters the below-level debug line", async () => {
        await lb.client.setLoggingLevel("info");
        const received: Array<{ level: string; data: unknown }> = [];
        lb.client.onLogMessage((m) => received.push({ level: m.level, data: m.data }));
        await lb.client.callTool("emit_logs", {});
        // Give the (dropped) debug line a chance to (not) arrive.
        await new Promise((r) => setTimeout(r, 20));
        expect(received).toEqual([{ level: "info", data: { msg: "info-line" } }]);
      });
    });

    // ─── elicitation ───
    describe("elicitation", () => {
      it("form elicit round-trips through the client-side ElicitationHarness", async () => {
        // ask_name → server ctx.elicit.text → wire → our client harness
        // → ElicitationHarness → auto-responder accepts { value: "Ada" }.
        const res = await lb.client.callTool("ask_name", {});
        expect(res.isError).toBeFalsy();
        expect(res.content).toEqual([{ type: "text", text: "Ada" }]);
      });

      it("url elicit round-trips (consent accepted)", async () => {
        const res = await lb.client.callTool("ask_consent", {});
        expect(res.isError).toBeFalsy();
        expect(res.content).toEqual([{ type: "text", text: "consented" }]);
      });
    });
  });
}

// ============================================================================
// Part A — tasks (Pattern B); era-independent, our client harness drives it
// ============================================================================

/** A short-running Pattern B tool for the tasks section. */
const lintRepoTool = createTool({
  name: "lint_repo",
  description: "Lint the repo as a background task.",
  inputSchema: emptySchema,
  annotations: { taskSupport: "required" },
  handler: async (_input, { ctx }) =>
    ctx.tasks!.submit(async ({ signal }) => {
      for (let i = 0; i < 3; i++) {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        await new Promise((r) => setTimeout(r, 20));
      }
      return [{ type: "text", text: "lint complete — 0 errors" } as ContentBlock];
    }),
});

async function makeTaskLoopback(): Promise<{
  client: McpClientHarness;
  close: () => Promise<void>;
}> {
  const transport = inMemoryServerTransport();
  const server = new McpServerHarness(
    `srv:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "tasks-conformance-server",
      transports: [transport],
      tools: [lintRepoTool],
      serverInfo: { name: "tasks-conformance", version: "0.0.0" },
    },
  );
  await server.ready;
  await server.start();
  const clientTransport = await transport.connect();
  const client = new McpClientHarness(
    `mcp:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      serverId: "tasks-loopback",
      transport: clientTransport,
      auth: new NoneAuth(),
      capabilities: { elicitation: { form: {} }, tasks: { listChanged: false } },
    },
  );
  await client.connect();
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function tasksSection(): void {
  describe("Part A — tasks (Pattern B, our client ↔ our server)", () => {
    // REGRESSION GUARD: our client's `callToolAsTask` sends the draft
    // `task` augmentation on `tools/call`. The SDK Server's
    // `assertToolsCallTaskCapability` rejects that unless the server
    // advertises `tasks.requests.tools.call` — which an earlier
    // `buildCapabilities` did NOT (`tasks: {}`), so a task-augmented call
    // failed against our own server. `buildCapabilities` now emits the
    // full `{ list, cancel, requests: { tools: { call } } }` shape; these
    // tests are the end-to-end proof, and would go red if that regresses.
    let client: McpClientHarness;
    let close: () => Promise<void>;
    beforeEach(async () => {
      ({ client, close } = await makeTaskLoopback());
    });
    afterEach(async () => {
      await close();
    });

    it("call-as-task returns a CreateTaskResult; get/result/list round-trip", async () => {
      const outcome = await client.callToolAsTask("lint_repo", {});
      expect(outcome._tag).toBe("task");
      if (outcome._tag !== "task") throw new Error("expected a task outcome");
      const taskId = outcome.result.task.taskId;
      expect(taskId).toMatch(/^task:/);

      // tasks/get — snapshot.
      const snapshot = await client.getTask(taskId);
      expect(snapshot.taskId).toBe(taskId);
      expect(["working", "completed"]).toContain(snapshot.status);

      // tasks/list — enumerates.
      const list = await client.listTasks();
      expect(list.tasks.some((t) => t.taskId === taskId)).toBe(true);

      // tasks/result — final payload (poll the snapshot until terminal).
      let status = snapshot.status;
      for (let i = 0; i < 200 && status !== "completed"; i++) {
        await new Promise((r) => setTimeout(r, 20));
        status = (await client.getTask(taskId)).status;
      }
      const payload = await client.getTaskResult(taskId);
      expect(payload.content).toEqual([{ type: "text", text: "lint complete — 0 errors" }]);
    });

    it("tasks/cancel returns a terminal snapshot", async () => {
      const outcome = await client.callToolAsTask("lint_repo", {});
      if (outcome._tag !== "task") throw new Error("expected a task outcome");
      const taskId = outcome.result.task.taskId;
      const cancelled = await client.cancelTask(taskId);
      expect(cancelled.taskId).toBe(taskId);
      expect(["cancelled", "completed"]).toContain(cancelled.status);
    });
  });
}

// ============================================================================
// Part B1 — reference CLIENT (raw SDK Client ↔ our server). Always available.
// ============================================================================

function referenceClientSection(factories: McpConformanceFactories): void {
  describe("Part B1 — reference client (SDK Client ↔ our server)", () => {
    let server: CanonicalServer;
    let client: SdkClient;
    beforeEach(async () => {
      server = await makeCanonicalServer(factories);
      const clientTransport = await server.transport.connect();
      client = new SdkClient(
        { name: "ref-client", version: "0.0.0" },
        { capabilities: { elicitation: { form: {}, url: {} } } },
      );
      await client.connect(clientTransport);
    });
    afterEach(async () => {
      await client.close();
      await server.close();
    });

    it("advertises ONLY the wired capabilities", () => {
      const caps = client.getServerCapabilities();
      expect(caps?.tools).toBeDefined();
      expect(caps?.prompts).toBeDefined();
      expect(caps?.resources).toMatchObject({ subscribe: true, listChanged: true });
      expect(caps?.completions).toBeDefined();
      expect(caps?.logging).toBeDefined();
      // Not wired on the canonical server → must be absent. `sampling` is
      // a CLIENT capability (servers never advertise it); `tasks` is only
      // advertised when a Pattern B tool is registered (none here).
      expect((caps as { tasks?: unknown }).tasks).toBeUndefined();
    });

    it("ping round-trips", async () => {
      // Our server's SDK Server answers ping automatically; assert the
      // reference client's ping resolves (our client harness has no ping
      // verb, so this is the reference-client's unique coverage).
      await expect(client.ping()).resolves.toBeDefined();
      void PingRequestSchema; // referenced for intent; SDK auto-handles ping
    });

    it("resources/subscribe → notifications/resources/updated; unsubscribe stops it", async () => {
      const updated: string[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
        updated.push(n.params.uri);
      });

      await client.subscribeResource({ uri: "mem://watched" });
      server.resources.notifyUpdated("mem://watched");
      await until(() => updated.length >= 1);
      expect(updated).toEqual(["mem://watched"]);

      await client.unsubscribeResource({ uri: "mem://watched" });
      server.resources.notifyUpdated("mem://watched");
      await new Promise((r) => setTimeout(r, 20));
      expect(updated).toEqual(["mem://watched"]); // no further deliveries
    });
  });
}

// ============================================================================
// Part B2 — reference SERVER (server-everything ↔ our client). Gated.
// ============================================================================

/**
 * Availability probe for the SDK reference server
 * `@modelcontextprotocol/server-everything`. Resolvable OR an explicit
 * `MCP_REFERENCE_SERVER` env flag enables the section; otherwise it
 * registers as skipped (the docker/pg pattern). server-everything
 * exercises resources / prompts / sampling / completion / logging —
 * exactly our surface — and is the only peer that can catch wire-shape
 * drift the shared-SDK loopback can't.
 */
function referenceServerAvailable(): boolean {
  if (process.env.MCP_REFERENCE_SERVER) return true;
  try {
    createRequire(import.meta.url).resolve("@modelcontextprotocol/server-everything");
    return true;
  } catch {
    return false;
  }
}

function referenceServerSection(): void {
  const available = referenceServerAvailable();
  const suite = available ? describe : describe.skip;
  suite("Part B2 — reference server (server-everything ↔ our client)", () => {
    // Lands when `@modelcontextprotocol/server-everything` is installed
    // (or `MCP_REFERENCE_SERVER` points at an entry). Drives OUR
    // McpClientHarness against the reference server over stdio so wire
    // drift surfaces. Kept minimal here; the wiring is intentionally a
    // TODO trailhead until the reference server is a dev dep.
    it.skip("drives our client harness against the reference server over stdio", () => {
      // TODO(mcp-conformance): spawn `@modelcontextprotocol/server-everything`
      // via `StdioClientTransport`, wrap with `McpClientHarness`, and
      // assert listTools / readResource / getPrompt / completion round-trip
      // against the reference implementation. Requires the package as a
      // dev dependency; add it, then remove this `.skip`.
      expect(available).toBe(true);
    });
  });
}

// ============================================================================
// Part C — era-codec normalization (forward guard)
// ============================================================================

function eraCodecNormalizationSection(): void {
  describe("Part C — era-codec normalization", () => {
    // Today only the `draft` codec exists; `selectCodec` maps every
    // known + unknown version to the draft passthrough. This section is
    // therefore a FORWARD GUARD: the matrix (Part A run under both eras)
    // proves the loopback is stable whichever era is configured, and
    // these unit assertions pin the selection + decode contract so a
    // future real 2025-11-25 codec has a landing spot with tests.
    const rawTool = {
      name: "sample",
      description: "d",
      inputSchema: { type: "object" as const },
      annotations: { title: "Sample" },
    };

    it("selects a codec for both draft and 2025-11-25", () => {
      // `"draft"` is still accepted on the wire — a server built against the
      // pre-publication draft reports it — and maps to canonical.
      expect(selectCodec("draft").era).toBe("2026-07-28");
      expect(selectCodec("2026-07-28").era).toBe("2026-07-28");
      expect(selectCodec("2025-11-25")).toBeDefined();
    });

    it("decodes a tool descriptor identically across the matrix (passthrough today)", () => {
      const a = selectCodec("2026-07-28").decodeTool(rawTool);
      const b = selectCodec("2025-11-25").decodeTool(rawTool);
      expect(a).toEqual(b);
      expect(a.name).toBe("sample");
    });
  });
}

// ============================================================================
// Sampling — DESIGNED, not landed. New-capability section seam.
// ============================================================================

function samplingSection(enabled: boolean): void {
  const suite = enabled ? describe : describe.skip;
  suite("Part A — sampling (server→client) [not landed]", () => {
    it.skip("server initiates sampling/createMessage; our client's model answers", () => {
      // TODO(mcp-sampling): the server harness advertises `sampling:
      // false` (no SamplingHarness). When server→client sampling lands,
      // flip `options.sections.sampling` and implement this round-trip.
      expect(true).toBe(true);
    });
  });
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Run the full MCP conformance suite (Parts A + B + C). Invoke from a
 * `*.spec.ts` file in a Node (non-jsdom) vitest environment, injecting
 * the concrete sibling-harness {@link McpConformanceFactories} (the
 * suite itself imports no concrete harness — see the interface).
 *
 * @example
 * ```ts
 * import { runMcpConformance } from "@agentick/mcp/testing";
 * import { ResourcesHarness } from "@agentick/resources";
 * import { PromptsHarness } from "@agentick/prompts";
 * import { ElicitationHarness } from "@agentick/elicitation";
 * import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
 *
 * runMcpConformance({
 *   async makeResources() {
 *     const h = new ResourcesHarness(`res:${generateId()}`, new MemoryJournal(), new LocalEventBus(), new LocalInbox());
 *     await h.ready;
 *     return h;
 *   },
 *   async makePrompts() {
 *     const h = new PromptsHarness(`pr:${generateId()}`, new MemoryJournal(), new LocalEventBus(), new LocalInbox());
 *     await h.ready;
 *     return h;
 *   },
 *   async makeElicitation(id, journal, bus, inbox) {
 *     const h = new ElicitationHarness(id, journal, bus, inbox);
 *     await h.ready;
 *     return h;
 *   },
 * });
 * ```
 */
export function runMcpConformance(
  factories: McpConformanceFactories,
  options: McpConformanceOptions = {},
): void {
  const suite = options.skip ? describe.skip : describe;
  const label = options.label ? ` — ${options.label}` : "";
  suite(`MCP conformance${label}`, () => {
    // Part A + C: the loopback suite run against BOTH eras (version matrix).
    for (const era of ["2026-07-28", "2025-11-25"] as const) {
      loopbackSections(factories, era);
    }
    // Part A: tasks (era-independent).
    tasksSection();
    // Part B1: reference client (always available).
    referenceClientSection(factories);
    // Part B2: reference server (gated; skips cleanly when absent).
    referenceServerSection();
    // Part C: era-codec normalization unit guard.
    eraCodecNormalizationSection();
    // Sampling seam — skipped until landed.
    samplingSection(options.sections?.sampling ?? false);
  });
}
