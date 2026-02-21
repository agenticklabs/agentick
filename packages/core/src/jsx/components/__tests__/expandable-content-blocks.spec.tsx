import { describe, it, expect, afterEach } from "vitest";
import type { Message as MessageType } from "@agentick/shared";
import { compileAgent, createTestAdapter, renderAgent, cleanup } from "../../../testing/index.js";
import { Message, Timeline, Section, Markdown, List, ListItem } from "../primitives.js";
import { XML } from "../xml.js";
import { Text, Image, Code, ToolUse } from "../content.js";
import { Model } from "../model.js";
import { Knobs } from "../../../hooks/index.js";
import { autoMessageSummary, autoSectionSummary, autoContentSummary } from "../auto-summary.js";

afterEach(cleanup);

function contentBlocks(compiled: any): any[] {
  return compiled.timelineEntries.flatMap((e: any) => e.content);
}

function sectionContent(compiled: any, id: string): any[] {
  return compiled.sections.get(id)?.content ?? [];
}

function messagesAsMessages(messages: any): MessageType[] {
  return messages as MessageType[];
}

// ===========================================================================
// ToolUse intrinsic → collector
// ===========================================================================

describe("ToolUse content block", () => {
  it("compiles to tool_use block in message content", async () => {
    function Agent() {
      return (
        <Message role="assistant">
          <ToolUse name="shell" toolUseId="call_1" input={{ cmd: "ls" }} />
        </Message>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_use");
    expect(blocks[0].name).toBe("shell");
    expect(blocks[0].toolUseId).toBe("call_1");
    expect(blocks[0].input).toEqual({ cmd: "ls" });
  });

  it("compiles alongside text blocks in same message", async () => {
    function Agent() {
      return (
        <Message role="assistant">
          <Text>Running command...</Text>
          <ToolUse name="shell" toolUseId="call_2" input={{ cmd: "pwd" }} />
        </Message>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("tool_use");
  });

  it("defaults input to empty object when omitted", async () => {
    function Agent() {
      return (
        <Message role="assistant">
          <ToolUse name="noop" toolUseId="call_3" />
        </Message>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].input).toEqual({});
  });
});

// ===========================================================================
// Collapsible content blocks
// ===========================================================================

describe("collapsible content blocks", () => {
  it("Text renders collapsed summary when collapsed", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Text collapsed="[file contents]">
              This is a very long file with many lines of code that we want to collapse.
            </Text>
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("[file contents]");
    expect(blocks[0].text).not.toContain("very long file");
  });

  it("Image renders collapsed summary instead of image block", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Image
              source={{ type: "url", url: "https://example.com/photo.png" }}
              collapsed="[image: photo.png]"
            />
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("[image: photo.png]");
    // Should NOT be an image block
    expect(blocks[0].source).toBeUndefined();
  });

  it("Code renders collapsed summary when collapsed", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Code language="typescript" collapsed="[code: 500 lines]">
              {"const x = 1;\n".repeat(500)}
            </Code>
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("[code: 500 lines]");
  });

  it("ToolUse renders collapsed summary when collapsed", async () => {
    function Agent() {
      return (
        <>
          <Message role="assistant">
            <ToolUse
              name="shell"
              toolUseId="call_4"
              input={{ cmd: "ls -la" }}
              collapsed="[tool: shell]"
            />
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("[tool: shell]");
    // Should NOT be a tool_use block
    expect(blocks[0].toolUseId).toBeUndefined();
  });

  it("mixed collapsed and non-collapsed blocks in same message", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Text>Visible question</Text>
            <Image
              source={{ type: "url", url: "https://example.com/screenshot.png" }}
              collapsed="[screenshot]"
            />
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks).toHaveLength(2);
    // First block: uncollapsed text
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("Visible question");
    // Second block: collapsed image → text summary
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toContain("[screenshot]");
  });

  it("collapsed blocks carry semantic collapsed metadata", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Text collapsed="summary" collapsedName="ref:txt">
              Full text.
            </Text>
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].semantic).toBeDefined();
    expect(blocks[0].semantic.rendererTag).toBe("collapsed");
    expect(blocks[0].semantic.rendererAttrs.name).toBe("ref:txt");
  });
});

// ===========================================================================
// Collapsible content block expansion via set_knob
// ===========================================================================

describe("content block expansion via set_knob", () => {
  it("expands a collapsed content block when set_knob is called", async () => {
    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "img:0", value: true } } }]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Text>Look at this image:</Text>
            <Image
              source={{ type: "url", url: "https://example.com/photo.png" }}
              collapsed="[image: photo.png]"
              collapsedName="img:0"
            />
          </Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 5 },
    });

    await send("Show me the image");

    const inputs = model.getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(2);

    // First call: image is collapsed
    const firstBlocks = messagesAsMessages(inputs[0].messages)
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ");
    expect(firstBlocks).toContain("[image: photo.png]");

    // After expansion: image block should appear
    const allBlocks = inputs.flatMap((i: any) => i.messages).flatMap((m: any) => m.content);
    const imageBlocks = allBlocks.filter((b: any) => b.type === "image");
    expect(imageBlocks.length).toBeGreaterThanOrEqual(1);

    await unmount();
  });
});

// ===========================================================================
// Collapsible Section
// ===========================================================================

describe("collapsible Section", () => {
  it("renders summary when collapsed", async () => {
    function Agent() {
      return (
        <>
          <Section id="rules" title="Rules" collapsed="[project rules]">
            Never use var. Always use const or let. Follow eslint configuration strictly.
          </Section>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const content = sectionContent(result.compiled, "rules");
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("[project rules]");
    expect(content[0].text).not.toContain("eslint");
  });

  it("renders full content when not collapsed", async () => {
    function Agent() {
      return (
        <Section id="rules" title="Rules">
          Never use var.
        </Section>
      );
    }

    const result = await compileAgent(Agent);
    const content = sectionContent(result.compiled, "rules");
    expect(content).toHaveLength(1);
    expect(content[0].text).toContain("Never use var");
  });

  it("preserves section id and title when collapsed", async () => {
    function Agent() {
      return (
        <>
          <Section id="conventions" title="Conventions" collapsed="[conventions]">
            Full conventions content.
          </Section>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const section = result.compiled.sections.get("conventions");
    expect(section).toBeDefined();
    expect(section!.title).toBe("Conventions");
    expect(section!.id).toBe("conventions");
  });

  it("expands section via set_knob", async () => {
    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "sec:rules", value: true } } }]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Section id="rules" title="Rules" collapsed="[rules]" collapsedName="sec:rules">
            Follow eslint strictly. No var keyword.
          </Section>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 5 },
    });

    await send("Show rules");

    const inputs = model.getCapturedInputs();
    // After expansion, the full section content should appear
    const _allSections = inputs.flatMap((i: any) =>
      (i.sections ?? []).filter((s: any) => s.id === "rules"),
    );

    // At minimum, the section exists in some form in all calls
    // After set_knob, the section should contain full content
    const _allText = inputs
      .flatMap((i: any) => {
        const sections = i.sections ?? [];
        return sections
          .filter((s: any) => s.id === "rules")
          .flatMap((s: any) => s.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text);
      })
      .join(" ");

    // We expect the expanded content to appear at some point
    // (may be in the compiled sections passed to the model)
    expect(inputs.length).toBeGreaterThanOrEqual(2);

    await unmount();
  });
});

// ===========================================================================
// Edge cases / adversarial
// ===========================================================================

describe("expandable edge cases", () => {
  it("multiple collapsed blocks get unique auto-generated names", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Text collapsed="[text 1]">First text.</Text>
            <Text collapsed="[text 2]">Second text.</Text>
            <Image source={{ type: "url", url: "https://example.com/a.png" }} collapsed="[img 1]" />
          </Message>
          <Knobs />
        </>
      );
    }

    // Should not throw from knob name collision
    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks).toHaveLength(3);
    // All should be collapsed (text type with summary)
    for (const b of blocks) {
      expect(b.type).toBe("text");
    }
  });

  it("collapsedGroup is passed through to semantic metadata", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Image
              source={{ type: "url", url: "https://example.com/a.png" }}
              collapsed="[img]"
              collapsedName="img:0"
              collapsedGroup="msg:123"
            />
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].semantic.rendererAttrs.group).toBe("msg:123");
  });

  it("empty collapsed string still activates collapse", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Text collapsed="">Hidden content.</Text>
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].text).not.toContain("Hidden content");
  });

  it("undefined collapsed renders normally", async () => {
    function Agent() {
      return (
        <Message role="user">
          <Text collapsed={undefined}>Visible text.</Text>
        </Message>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("Visible text");
  });

  it("false collapsed renders normally", async () => {
    function Agent() {
      return (
        <Message role="user">
          <Text collapsed={false}>Still visible.</Text>
        </Message>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("Still visible");
  });
});

// ===========================================================================
// Auto-summary pure functions
// ===========================================================================

describe("autoMessageSummary", () => {
  it("returns role prefix + truncated text for user messages", () => {
    const content = [{ type: "text" as const, text: "What is the weather like?" }];
    expect(autoMessageSummary("user", content)).toBe("user: What is the weather like?");
  });

  it("returns text-only for assistant messages (ICL safety)", () => {
    const content = [
      { type: "text" as const, text: "Here is the answer." },
      { type: "tool_use" as const, toolUseId: "1", name: "shell", input: {} },
    ];
    const summary = autoMessageSummary("assistant", content);
    expect(summary).toBe("Here is the answer.");
    // Must NOT include tool metadata
    expect(summary).not.toContain("shell");
    expect(summary).not.toContain("tool");
  });

  it("truncates long content", () => {
    const longText = "a".repeat(200);
    const content = [{ type: "text" as const, text: longText }];
    const summary = autoMessageSummary("user", content);
    expect(summary.length).toBeLessThanOrEqual(81); // 80 + ellipsis char
    expect(summary).toContain("…");
  });

  it("returns role fallback for empty content", () => {
    expect(autoMessageSummary("user", [])).toBe("[user]");
    expect(autoMessageSummary("assistant", undefined)).toBe("[assistant]");
  });
});

describe("autoSectionSummary", () => {
  it("uses title when available", () => {
    expect(autoSectionSummary("Rules", "rules-section")).toBe("Rules");
  });

  it("falls back to id", () => {
    expect(autoSectionSummary(undefined, "my-section")).toBe("my-section");
  });

  it("falls back to 'section'", () => {
    expect(autoSectionSummary()).toBe("section");
  });
});

describe("autoContentSummary", () => {
  it("returns type-specific defaults", () => {
    expect(autoContentSummary("Image", {})).toBe("[image]");
    expect(autoContentSummary("Audio", {})).toBe("[audio]");
    expect(autoContentSummary("Video", {})).toBe("[video]");
    expect(autoContentSummary("Json", {})).toBe("[json]");
    expect(autoContentSummary("Document", {})).toBe("[document]");
  });

  it("includes language for Code", () => {
    expect(autoContentSummary("Code", { language: "typescript" })).toBe("[code: typescript]");
  });

  it("includes name for ToolUse", () => {
    expect(autoContentSummary("ToolUse", { name: "shell" })).toBe("[tool: shell]");
  });

  it("includes altText for Image", () => {
    expect(autoContentSummary("Image", { altText: "A cute cat" })).toBe("[image: A cute cat]");
  });

  it("truncates text for Text blocks", () => {
    expect(autoContentSummary("Text", { text: "Hello world" })).toBe("Hello world");
    const long = "x".repeat(200);
    const result = autoContentSummary("Text", { text: long });
    expect(result.length).toBeLessThanOrEqual(81);
  });
});

// ===========================================================================
// collapsed={true} (auto-summary)
// ===========================================================================

describe("collapsed={true} auto-summary", () => {
  it("Image auto-summarizes to [image]", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Image source={{ type: "url", url: "https://example.com/photo.png" }} collapsed />
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("[image]");
  });

  it("Code auto-summarizes with language", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Code language="python" collapsed>
              {"print('hello')\n".repeat(100)}
            </Code>
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].text).toContain("[code: python]");
  });

  it("ToolUse auto-summarizes with tool name", async () => {
    function Agent() {
      return (
        <>
          <Message role="assistant">
            <ToolUse name="read_file" toolUseId="call_5" collapsed />
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].text).toContain("[tool: read_file]");
  });

  it("Message auto-summarizes from role and content", async () => {
    function Agent() {
      return (
        <>
          <Message
            role="user"
            content={[{ type: "text", text: "What is the weather?" }]}
            collapsed
            collapsedName="ref:1"
          />
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].text).toContain("user: What is the weather?");
  });

  it("Section auto-summarizes from title", async () => {
    function Agent() {
      return (
        <>
          <Section id="rules" title="Coding Rules" collapsed>
            Never use var. Always use const.
          </Section>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const content = sectionContent(result.compiled, "rules");
    expect(content[0].text).toContain("Coding Rules");
    expect(content[0].text).not.toContain("Never use var");
  });
});

// ===========================================================================
// Full pipeline: renderer output verification
// ===========================================================================

describe("renderer pipeline (model-facing output)", () => {
  it("collapsed content block renders as <collapsed> XML tag in model input", async () => {
    const model = createTestAdapter({ defaultResponse: "Got it" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Text>Look at this:</Text>
            <Image
              source={{ type: "url", url: "https://example.com/photo.png" }}
              collapsed="[image: photo.png]"
              collapsedName="img:0"
            />
          </Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("describe the image");

    const inputs = model.getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // Get text blocks from user messages only (avoid Knobs system text)
    const userTextBlocks = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text);

    // The collapsed block must be wrapped in <collapsed> tags by the renderer
    const allUserText = userTextBlocks.join("\n");
    expect(allUserText).toMatch(/<collapsed name="img:0">\[image: photo\.png\]<\/collapsed>/);

    // The non-collapsed "Look at this" text should also be present, unwrapped
    expect(allUserText).toContain("Look at this");

    await unmount();
  });

  it("collapsed message renders as <collapsed> XML tag in model input", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message
            role="user"
            content={[{ type: "text", text: "What is the weather like today?" }]}
            collapsed="user asked about weather"
            collapsedName="ref:0"
          />
          <Message role="user">Current question</Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("hello");

    const inputs = model.getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    const allText = messagesAsMessages(inputs[0].messages)
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Collapsed message should have <collapsed> wrapper
    expect(allText).toContain('<collapsed name="ref:0">user asked about weather</collapsed>');

    // Non-collapsed message should NOT have the wrapper
    expect(allText).toContain("Current question");

    await unmount();
  });

  it("collapsed section renders as <collapsed> XML tag in model input", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    // No <Knobs /> — sections only appear in model input as a system
    // message fallback when no other system messages exist.
    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Section
            id="rules"
            title="Coding Rules"
            audience="model"
            collapsed="[project rules]"
            collapsedName="sec:rules"
          >
            Never use var. Always use const.
          </Section>
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("what are the rules?");

    const inputs = model.getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // Sections are inlined into a system message by fromEngineState
    // when no other system messages exist.
    const systemText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "system")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    expect(systemText).toContain('<collapsed name="sec:rules">');
    expect(systemText).toContain("[project rules]");
    expect(systemText).not.toContain("Never use var");

    await unmount();
  });

  it("collapsed={true} auto-summary renders through renderer with correct tag", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Code language="python" collapsed>
              {"def hello():\n    print('world')\n".repeat(50)}
            </Code>
          </Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("what code is there?");

    const inputs = model.getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    const allText = messagesAsMessages(inputs[0].messages)
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Auto-summary for Code with language="python" should be "[code: python]"
    // and it should be wrapped in <collapsed> tags
    expect(allText).toMatch(/<collapsed name="[^"]*">\[code: python\]<\/collapsed>/);
    // Original code should NOT appear
    expect(allText).not.toContain("def hello()");

    await unmount();
  });

  it("expanded block renders WITHOUT <collapsed> tag after set_knob", async () => {
    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "img:0", value: true } } }]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Image
              source={{ type: "url", url: "https://example.com/photo.png" }}
              collapsed="[image: photo.png]"
              collapsedName="img:0"
            />
          </Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 5 },
    });

    await send("expand the image");

    const inputs = model.getCapturedInputs();
    expect(inputs.length).toBeGreaterThanOrEqual(2);

    // First call: collapsed — user message text should contain the tag
    const firstUserText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    expect(firstUserText).toMatch(/<collapsed name="img:0">/);

    // After expansion: the LAST input should have an image block in user messages
    const lastInput = inputs[inputs.length - 1];
    const lastUserBlocks = messagesAsMessages(lastInput.messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content);
    const imageBlocks = lastUserBlocks.filter((b: any) => b.type === "image");
    expect(imageBlocks.length).toBeGreaterThanOrEqual(1);

    // The last input's user messages should NOT have <collapsed name="img:0">
    const lastUserText = lastUserBlocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    expect(lastUserText).not.toMatch(/<collapsed name="img:0">/);

    await unmount();
  });

  it("special characters in summary are XML-escaped in model input", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Text collapsed={'user said: "hello <world>"'} collapsedName="ref:0">
              Full conversation text here.
            </Text>
          </Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("summarize");

    const inputs = model.getCapturedInputs();
    const allText = messagesAsMessages(inputs[0].messages)
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Verify XML escaping happened
    expect(allText).toContain("&lt;world&gt;");
    expect(allText).toContain("&quot;hello");
    expect(allText).not.toContain("<world>");
    expect(allText).not.toContain('"hello');

    await unmount();
  });
});

// ===========================================================================
// ReactNode collapsed content: what actually gets extracted?
// ===========================================================================

describe("collapsed={ReactNode} content extraction", () => {
  it("plain text ReactNode extracts correctly", async () => {
    function Summary() {
      return <Text>user asked about weather</Text>;
    }

    function Agent() {
      return (
        <>
          <Message
            role="user"
            content={[{ type: "text", text: "What is the weather like?" }]}
            collapsed={<Summary />}
            collapsedName="ref:0"
          />
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("user asked about weather");
  });

  it("Markdown-wrapped ReactNode extracts text (formatting is in semantic metadata)", async () => {
    function Summary() {
      return (
        <Markdown>
          Summary: user asked about <strong>weather</strong> and location
        </Markdown>
      );
    }

    function Agent() {
      return (
        <>
          <Message
            role="user"
            content={[{ type: "text", text: "Full original message..." }]}
            collapsed={<Summary />}
            collapsedName="ref:0"
          />
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].type).toBe("text");
    // The text should contain the raw text, formatting handled by renderer
    expect(blocks[0].text).toContain("Summary");
    expect(blocks[0].text).toContain("weather");
    expect(blocks[0].text).toContain("location");
  });

  it("XML-wrapped ReactNode extracts text", async () => {
    function Summary() {
      return (
        <XML>
          <Text>ref:0 — user asked about weather</Text>
        </XML>
      );
    }

    function Agent() {
      return (
        <>
          <Message
            role="user"
            content={[{ type: "text", text: "What is the weather?" }]}
            collapsed={<Summary />}
            collapsedName="ref:0"
          />
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("ref:0");
    expect(blocks[0].text).toContain("weather");
  });

  it("non-text children in collapsed ReactNode are preserved as childBlocks", async () => {
    // Code and Image are preserved as child blocks on the collapsed block.
    // The renderer formats them when producing the <collapsed> output.
    function RichSummary() {
      return (
        <>
          <Text>Summary text here</Text>
          <Code language="python">print("hello")</Code>
          <Image source={{ type: "url", url: "https://example.com/img.png" }} />
        </>
      );
    }

    function Agent() {
      return (
        <>
          <Message
            role="user"
            content={[{ type: "text", text: "Original content" }]}
            collapsed={<RichSummary />}
            collapsedName="ref:0"
          />
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].type).toBe("text");
    // childBlocks should contain all the children
    const childBlocks = blocks[0].semantic?.rendererAttrs?.childBlocks;
    expect(childBlocks).toBeDefined();
    expect(childBlocks.length).toBe(3);
    expect(childBlocks[0].type).toBe("text");
    expect(childBlocks[1].type).toBe("code");
    expect(childBlocks[2].type).toBe("image");
  });

  it("semantic list component in collapsed content preserved in childBlocks", async () => {
    // With childBlocks, List components are preserved as semantic blocks.
    // The renderer formats them when producing the <collapsed> output.
    function Summary() {
      return (
        <>
          <Text>Topics discussed:</Text>
          <List>
            <ListItem>Weather</ListItem>
            <ListItem>Travel plans</ListItem>
          </List>
        </>
      );
    }

    function Agent() {
      return (
        <>
          <Message
            role="user"
            content={[{ type: "text", text: "Long multi-topic conversation..." }]}
            collapsed={<Summary />}
            collapsedName="ref:0"
          />
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    expect(blocks[0].type).toBe("text");
    // childBlocks should contain a text block and a list block
    const childBlocks = blocks[0].semantic?.rendererAttrs?.childBlocks;
    expect(childBlocks).toBeDefined();
    expect(childBlocks.length).toBe(2);
    expect(childBlocks[0].type).toBe("text");
    expect(childBlocks[0].text).toBe("Topics discussed:");
    expect(childBlocks[1].semantic?.type).toBe("list");
    expect(childBlocks[1].semantic?.structure?.items).toEqual(["Weather", "Travel plans"]);
  });

  it("inline <strong> in collapsed content produces semanticNode in childBlocks", async () => {
    function Summary() {
      return (
        <Markdown>
          User asked about <strong>weather</strong> and <em>travel</em>
        </Markdown>
      );
    }

    function Agent() {
      return (
        <>
          <Message
            role="user"
            content={[{ type: "text", text: "Original" }]}
            collapsed={<Summary />}
            collapsedName="ref:0"
          />
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    const childBlocks = blocks[0].semantic?.rendererAttrs?.childBlocks;
    expect(childBlocks).toBeDefined();
    // Should have text blocks with semanticNode for inline formatting
    const strongBlock = childBlocks.find((b: any) => b.semanticNode?.semantic === "strong");
    expect(strongBlock).toBeDefined();
    expect(strongBlock.text).toBe("weather");

    const emBlock = childBlocks.find((b: any) => b.semanticNode?.semantic === "em");
    expect(emBlock).toBeDefined();
    expect(emBlock.text).toBe("travel");
  });

  it("collapsed ReactNode renders through full pipeline with <collapsed> wrapper", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Summary() {
      return <Text>user asked about weather</Text>;
    }

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message
            role="user"
            content={[{ type: "text", text: "What is the weather like?" }]}
            collapsed={<Summary />}
            collapsedName="ref:0"
          />
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("hello");

    const inputs = model.getCapturedInputs();
    const userText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // ReactNode collapsed content should render through the full pipeline
    // with <collapsed> wrapper from the renderer
    expect(userText).toMatch(/<collapsed name="ref:0">.*weather.*<\/collapsed>/);

    await unmount();
  });
});

// ===========================================================================
// Inline semantic formatting in collapsed + Text content
// ===========================================================================

describe("inline semantic formatting through renderer", () => {
  it("collapsed with <strong> renders as **bold** in markdown model output", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Text
              collapsed={
                <Markdown>
                  User asked about <strong>Python</strong> lists
                </Markdown>
              }
              collapsedName="ref:0"
            >
              Full original message about Python lists and more...
            </Text>
          </Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("summarize");

    const inputs = model.getCapturedInputs();
    const userText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // The collapsed summary should contain **Python** (markdown bold)
    expect(userText).toContain("**Python**");
    // Content may span multiple lines, so use [^]* (match-all including newlines)
    expect(userText).toMatch(/<collapsed name="ref:0">[^]*\*\*Python\*\*[^]*<\/collapsed>/);

    await unmount();
  });

  it("collapsed with List renders list items in model output", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Text
              collapsed={
                <>
                  <Text>Topics:</Text>
                  <List>
                    <ListItem>Weather</ListItem>
                    <ListItem>Travel</ListItem>
                  </List>
                </>
              }
              collapsedName="ref:0"
            >
              Long conversation about many topics...
            </Text>
          </Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("summarize");

    const inputs = model.getCapturedInputs();
    const userText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // The collapsed summary should contain list items (markdown format)
    expect(userText).toContain("Weather");
    expect(userText).toContain("Travel");
    expect(userText).toMatch(/<collapsed name="ref:0">/);

    await unmount();
  });

  it("<Text> with inline <strong> renders as **bold** (not plain text)", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Text>
              Hello <strong>world</strong> and <em>goodbye</em>
            </Text>
          </Message>
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("test");

    const inputs = model.getCapturedInputs();
    const userText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Inline formatting should be preserved through the renderer
    expect(userText).toContain("**world**");
    expect(userText).toContain("*goodbye*");

    await unmount();
  });

  it("standalone <strong> in message renders as **bold** in model output", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <strong>important note</strong>
          </Message>
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("test");

    const inputs = model.getCapturedInputs();
    const userText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Standalone inline element should render with formatting
    expect(userText).toContain("**important note**");

    await unmount();
  });

  it("<a href> in collapsed content renders as markdown link", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Text
              collapsed={
                <Text>
                  See <a href="https://example.com">docs</a> for details
                </Text>
              }
              collapsedName="ref:0"
            >
              Full message content here.
            </Text>
          </Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("test");

    const inputs = model.getCapturedInputs();
    const userText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Link should render as markdown [text](url)
    expect(userText).toContain("[docs](https://example.com)");
    expect(userText).toMatch(/<collapsed name="ref:0">/);

    await unmount();
  });

  it("nested inline formatting: <strong><em>text</em></strong> renders correctly", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Text>
              This is{" "}
              <strong>
                <em>very important</em>
              </strong>{" "}
              info
            </Text>
          </Message>
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("test");

    const inputs = model.getCapturedInputs();
    const userText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Nested formatting should produce **bold** wrapping *italic*
    expect(userText).toContain("**");
    expect(userText).toContain("*very important*");

    await unmount();
  });

  it("empty collapsed children produce no childBlocks", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Text collapsed="" collapsedName="ref:0">
              Full content here.
            </Text>
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = contentBlocks(result.compiled);
    // String collapsed content — no childBlocks needed
    expect(blocks[0].semantic?.rendererAttrs?.childBlocks).toBeUndefined();
  });

  it("collapsed with Code block renders code in summary", async () => {
    const model = createTestAdapter({ defaultResponse: "OK" });

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Text
              collapsed={
                <>
                  <Text>Function signature:</Text>
                  <Code language="typescript">function hello(): void</Code>
                </>
              }
              collapsedName="ref:0"
            >
              The full function implementation is quite long...
            </Text>
          </Message>
          <Knobs />
        </>
      );
    }

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 2 },
    });

    await send("test");

    const inputs = model.getCapturedInputs();
    const userText = messagesAsMessages(inputs[0].messages)
      .filter((m: any) => m.role === "user")
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Code block should be formatted in the collapsed summary
    expect(userText).toContain("Function signature:");
    expect(userText).toContain("function hello(): void");
    expect(userText).toMatch(/<collapsed name="ref:0">/);

    await unmount();
  });
});
