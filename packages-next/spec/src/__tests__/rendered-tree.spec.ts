import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ContentBlock,
  ContextEntry,
  ContextSpec,
  ExecutionResult,
  ExecutionTarget,
  ExecutorError,
  ExecutorTerminal,
  FormatInput,
  FormatResult,
  FormatScope,
  FormatTrace,
  SemanticContentBlock,
  FormattedContent,
  FormatterRef,
  ImageBlock,
  LanguageModelExecutionResult,
  LanguageModelTarget,
  MCPDeclaration,
  MessageEntry,
  ModelSelection,
  OutputDeclaration,
  RenderedTree,
  ResourceDeclaration,
  ResponseFormat,
  RuntimeDeclarations,
  SectionEntry,
  SemanticMetadata,
  SemanticNode,
  SpecConfig,
  TextBlock,
  ToolBlock,
  ToolCall,
  ToolDeclaration,
  ToolExposure,
  ToolUseBlock,
  UrlSource,
  UsageStats,
} from "../index.js";
import { jsonSchema, ProviderTimeout } from "../index.js";

describe("@agentick/spec-next — compiler-facing types", () => {
  describe("ContentBlock", () => {
    it("narrows on the type discriminator", () => {
      const text: TextBlock = { type: "text", text: "hello" };
      const block: ContentBlock = text;
      if (block.type === "text") {
        expectTypeOf(block.text).toEqualTypeOf<string>();
      }
    });

    it("preserves role-scoped tool block subset", () => {
      const use: ToolUseBlock = {
        type: "tool_use",
        toolUseId: "tu_1",
        name: "add",
        input: { a: 1 },
      };
      const tb: ToolBlock = use;
      expect(tb.type).toBe("tool_use");
    });

    it("accepts url-source media blocks", () => {
      const src: UrlSource = { type: "url", url: "https://x.test/a.png" };
      const img: ImageBlock = { type: "image", source: src, altText: "x" };
      expect(img.source.type).toBe("url");
    });
  });

  describe("SemanticNode", () => {
    it("nests children and carries rendererRef instead of a function", () => {
      const ref: FormatterRef = { id: "md", format: "markdown" };
      const node: SemanticNode = {
        semantic: "paragraph",
        children: [{ text: "hello " }, { semantic: "strong", children: [{ text: "world" }] }],
        rendererRef: ref,
      };
      expect(node.rendererRef?.id).toBe("md");
    });

    it("SemanticContentBlock is ContentBlock + optional semantic metadata", () => {
      const meta: SemanticMetadata = { type: "heading", level: 2 };
      const fb: SemanticContentBlock = {
        type: "text",
        text: "Hi",
        semantic: meta,
      };
      expect(fb.semantic?.level).toBe(2);
    });
  });

  describe("Formatter protocol", () => {
    it("FormatInput carries content + purpose", () => {
      const input: FormatInput = {
        content: [{ type: "text", text: "x" }],
        purpose: "message",
      };
      expect(input.purpose).toBe("message");
    });

    it("FormatScope nests other formatters", () => {
      const scope: FormatScope = {
        kind: "renderer-scope",
        renderer: { id: "xml", format: "xml" },
        content: [{ type: "text", text: "inner" }],
      };
      expect(scope.kind).toBe("renderer-scope");
    });

    it("FormatResult and FormattedContent are the same shape", () => {
      expectTypeOf<FormatResult>().toEqualTypeOf<FormattedContent>();
    });

    it("FormatTrace nests children", () => {
      const trace: FormatTrace = {
        renderer: { id: "md" },
        children: [{ renderer: { id: "md.inner" } }],
      };
      expect(trace.children).toHaveLength(1);
    });
  });

  describe("ContextSpec entries", () => {
    it("MessageEntry discriminates on kind", () => {
      const msg: MessageEntry = {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: "hi" }],
      };
      const e: ContextEntry = msg;
      if (e.kind === "message") {
        expectTypeOf(e.role).toEqualTypeOf<MessageEntry["role"]>();
      }
    });

    it("SectionEntry requires id", () => {
      const sec: SectionEntry = {
        kind: "section",
        id: "sec.todo",
        title: "Todos",
        content: [{ type: "text", text: "1. ship spec" }],
      };
      expect(sec.id).toBe("sec.todo");
    });

    it("ContextSpec is just an entries array", () => {
      const spec: ContextSpec = {
        entries: [
          { kind: "message", role: "system", content: [{ type: "text", text: "S" }] },
          { kind: "section", id: "s", content: [] },
        ],
      };
      expect(spec.entries).toHaveLength(2);
    });
  });

  describe("RuntimeDeclarations", () => {
    it("ToolDeclaration carries exposure list", () => {
      const tool: ToolDeclaration = {
        id: "t.add",
        name: "add",
        description: "Add two numbers",
        inputSchema: jsonSchema({ type: "object" }),
        exposure: ["model", "dispatch"],
        handlerRef: "handlers/add",
      };
      const exposure: readonly ToolExposure[] = tool.exposure;
      expect(exposure).toContain("model");
    });

    it("OutputDeclaration is distinct from ResponseFormat", () => {
      const out: OutputDeclaration = { id: "out.summary", mode: "json" };
      const rf: ResponseFormat = { type: "json" };
      expect(out.id).toBe("out.summary");
      expect(rf.type).toBe("json");
    });

    it("MCPDeclaration carries transport + config", () => {
      const mcp: MCPDeclaration = {
        id: "mcp.local",
        serverName: "tools",
        transport: "stdio",
        config: { command: "node", args: ["server.js"] },
        exposes: ["tools", "resources"],
      };
      expect(mcp.transport).toBe("stdio");
    });

    it("RuntimeDeclarations aggregates all four", () => {
      const decls: RuntimeDeclarations = {
        tools: [],
        resources: [] as ResourceDeclaration[],
        outputs: [],
        mcp: [],
      };
      expect(Object.keys(decls)).toHaveLength(4);
    });
  });

  describe("RenderedTree", () => {
    it("accepts the minimum valid shape (specVersion + context)", () => {
      const tree: RenderedTree = {
        specVersion: "2026-05-01",
        context: { entries: [] },
      };
      expect(tree.specVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("supports free-root rendering channels", () => {
      const tree: RenderedTree = {
        specVersion: "2026-05-01",
        context: { entries: [] },
        content: [{ type: "text", text: "free-root" }],
        text: "free-root",
        mimeType: "text/markdown",
        renderedWith: { id: "md" },
      };
      expect(tree.text).toBe("free-root");
    });

    it("SpecConfig allows ModelSelection variants", () => {
      const byId: ModelSelection = { kind: "by-id", id: "gpt-4o" };
      const byRef: ModelSelection = { kind: "by-ref", ref: "default" };
      const cfg: SpecConfig = { model: byId, responseFormat: { type: "text" } };
      expect(cfg.model).toEqual(byId);
      expect(byRef.kind).toBe("by-ref");
    });
  });

  describe("ExecutionResult + ExecutorTerminal", () => {
    it("LanguageModelExecutionResult extends ExecutionResult", () => {
      const usage: UsageStats = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      const lm: LanguageModelExecutionResult = {
        specVersion: "2026-05-01",
        output: [{ type: "text", text: "ok" }],
        stopReason: "end",
        usage,
      };
      const base: ExecutionResult = lm;
      expect(base.output).toHaveLength(1);
    });

    it("ExecutorTerminal discriminates on outcome", () => {
      const ok: ExecutorTerminal = {
        outcome: "succeeded",
        result: { specVersion: "2026-05-01", output: [] },
      };
      const err: ExecutorError = new ProviderTimeout({ timeoutMs: 30_000 });
      const fail: ExecutorTerminal = { outcome: "failed", error: err };
      const cancel: ExecutorTerminal = { outcome: "canceled", reason: "user" };
      const veto: ExecutorTerminal = { outcome: "vetoed", reason: "policy" };
      const replace: ExecutorTerminal = {
        outcome: "replaced",
        result: { specVersion: "2026-05-01", output: [] },
      };
      expect([ok, fail, cancel, veto, replace]).toHaveLength(5);
    });

    it("ToolCall input is unknown (not any)", () => {
      const call: ToolCall = { id: "c.1", name: "add", input: { a: 1 } };
      expectTypeOf(call.input).toEqualTypeOf<unknown>();
    });
  });

  describe("ExecutionTarget", () => {
    it("LanguageModelTarget pins kind", () => {
      const target: LanguageModelTarget = {
        kind: "language-model",
        provider: "openai",
        modelId: "gpt-4o",
        capabilities: { supportsTools: true, contextWindow: 128_000 },
      };
      const base: ExecutionTarget = target;
      expect(base.kind).toBe("language-model");
    });
  });
});
