/**
 * Compiled Content Tests
 *
 * Tests for verifying the compiled structure that goes to the model.
 * Uses real component imports to exercise the full rendering pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FiberCompiler } from "../fiber-compiler";
import { markdownRenderer } from "../../renderers";
import type { CompiledStructure, CompiledSection } from "../types";
import { createMockCom, createMockTickState } from "../../testing";
import { Section, Message, Tool } from "../../jsx/components/primitives";
import { Ephemeral } from "../../jsx/components/messages";
import {
  Text as TextComponent,
  Code as CodeComponent,
  Image as ImageComponent,
  Json as JsonComponent,
  // Audio as AudioComponent,
  // Video as VideoComponent,
  // Document as DocumentComponent,
} from "../../jsx/components/content";
import {
  H1,
  H2,
  H3,
  Header,
  Paragraph,
  List,
  ListItem,
  Table,
  Row,
  Column,
} from "../../jsx/components/semantic";
import { Collapsed } from "../../jsx/components/collapsed";

// Helper to get section by id
function getSection(compiled: CompiledStructure, id: string): CompiledSection | undefined {
  return compiled.sections.get(id);
}

// Helper to render section content as string
function renderSectionContent(section: CompiledSection): string {
  const renderer = section.renderer ?? markdownRenderer;
  const formatted = renderer.format(section.content);
  return formatted
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

describe("Compiled Content", () => {
  let ctx: ReturnType<typeof createMockCom>;
  let compiler: FiberCompiler;
  let tickState: any;

  beforeEach(() => {
    ctx = createMockCom();
    compiler = new FiberCompiler(ctx);
    tickState = createMockTickState();
  });

  // ============================================================
  // Section Collection
  // ============================================================

  describe("section collection", () => {
    it("should collect a single section with id", async () => {
      const App = () => (
        <Section id="main">
          <TextComponent text="Hello World" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.sections.size).toBe(1);
      const section = getSection(compiled, "main");
      expect(section).toBeDefined();
      expect(section!.id).toBe("main");
    });

    it("should collect section title", async () => {
      const App = () => (
        <Section id="intro" title="Introduction">
          <TextComponent text="Content here" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "intro");

      expect(section!.title).toBe("Introduction");
    });

    it("should collect section visibility", async () => {
      const App = () => (
        <>
          <Section id="visible" visibility="model">
            <TextComponent text="For model" />
          </Section>
          <Section id="logged" visibility="log">
            <TextComponent text="For logs" />
          </Section>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(getSection(compiled, "visible")!.visibility).toBe("model");
      expect(getSection(compiled, "logged")!.visibility).toBe("log");
    });

    it("should collect section audience", async () => {
      const App = () => (
        <>
          <Section id="for-model" audience="model">
            <TextComponent text="System instructions" />
          </Section>
          <Section id="for-user" audience="user">
            <TextComponent text="User-facing content" />
          </Section>
          <Section id="for-all" audience="all">
            <TextComponent text="Universal content" />
          </Section>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(getSection(compiled, "for-model")!.audience).toBe("model");
      expect(getSection(compiled, "for-user")!.audience).toBe("user");
      expect(getSection(compiled, "for-all")!.audience).toBe("all");
    });

    it("should collect section tags", async () => {
      const App = () => (
        <Section id="tagged" tags={["important", "system"]}>
          <TextComponent text="Tagged content" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "tagged");

      expect(section!.tags).toEqual(["important", "system"]);
    });

    it("should collect section metadata", async () => {
      const App = () => (
        <Section id="meta" metadata={{ priority: 1, source: "user" }}>
          <TextComponent text="With metadata" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "meta");

      expect(section!.metadata).toEqual({ priority: 1, source: "user" });
    });

    it("should merge sections with same id", async () => {
      const App = () => (
        <>
          <Section id="merged">
            <TextComponent text="First part" />
          </Section>
          <Section id="merged">
            <TextComponent text="Second part" />
          </Section>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.sections.size).toBe(1);
      const section = getSection(compiled, "merged");
      expect(section!.content.length).toBe(2);
    });

    it("should collect multiple distinct sections", async () => {
      const App = () => (
        <>
          <Section id="header">
            <TextComponent text="Header" />
          </Section>
          <Section id="body">
            <TextComponent text="Body" />
          </Section>
          <Section id="footer">
            <TextComponent text="Footer" />
          </Section>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.sections.size).toBe(3);
      expect(getSection(compiled, "header")).toBeDefined();
      expect(getSection(compiled, "body")).toBeDefined();
      expect(getSection(compiled, "footer")).toBeDefined();
    });
  });

  // ============================================================
  // Content Blocks
  // ============================================================

  describe("content blocks", () => {
    it("should collect Text content", async () => {
      const App = () => (
        <Section id="text-test">
          <TextComponent text="Hello World" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "text-test");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("text");
      expect(section!.content[0].text).toBe("Hello World");
    });

    it("should collect Code content", async () => {
      const App = () => (
        <Section id="code-test">
          <CodeComponent text="const x = 42;" language="typescript" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "code-test");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("code");
      expect((section!.content[0] as any).text).toBe("const x = 42;");
      expect((section!.content[0] as any).language).toBe("typescript");
    });

    it("should collect Image content", async () => {
      const App = () => (
        <Section id="image-test">
          <ImageComponent
            source={{ type: "url", url: "https://example.com/img.png" }}
            altText="Example"
          />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "image-test");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("image");
      expect((section!.content[0] as any).source).toEqual({
        type: "url",
        url: "https://example.com/img.png",
      });
      expect((section!.content[0] as any).altText).toBe("Example");
    });

    it("should collect Json content", async () => {
      const data = { name: "Test", value: 123 };
      const App = () => (
        <Section id="json-test">
          <JsonComponent data={data} />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "json-test");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("json");
      expect((section!.content[0] as any).data).toEqual(data);
    });

    it("should collect multiple content blocks in order", async () => {
      const App = () => (
        <Section id="multi-content">
          <TextComponent text="Introduction" />
          <CodeComponent text='console.log("hi")' language="js" />
          <TextComponent text="Conclusion" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "multi-content");

      expect(section!.content.length).toBe(3);
      expect(section!.content[0].type).toBe("text");
      expect(section!.content[1].type).toBe("code");
      expect(section!.content[2].type).toBe("text");
    });
  });

  // ============================================================
  // Content Rendering
  // ============================================================

  describe("content rendering", () => {
    it("should render text as plain text", async () => {
      const App = () => (
        <Section id="render-text">
          <TextComponent text="Simple text content" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "render-text");
      const rendered = renderSectionContent(section!);

      expect(rendered).toBe("Simple text content");
    });

    it("should pass through code blocks as native content", async () => {
      const App = () => (
        <Section id="render-code">
          <CodeComponent text='print("hello")' language="python" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "render-code");
      const renderer = section!.renderer ?? markdownRenderer;
      const formatted = renderer.format(section!.content);

      expect(formatted.length).toBe(1);
      expect(formatted[0].type).toBe("code");
      expect((formatted[0] as any).text).toBe('print("hello")');
      expect((formatted[0] as any).language).toBe("python");
    });

    it("should pass through image blocks as native content", async () => {
      const App = () => (
        <Section id="render-image">
          <ImageComponent
            source={{ type: "url", url: "https://example.com/pic.jpg" }}
            altText="A picture"
          />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "render-image");
      const renderer = section!.renderer ?? markdownRenderer;
      const formatted = renderer.format(section!.content);

      expect(formatted.length).toBe(1);
      expect(formatted[0].type).toBe("image");
      expect((formatted[0] as any).source).toEqual({
        type: "url",
        url: "https://example.com/pic.jpg",
      });
    });

    it("should pass through json blocks as native content", async () => {
      const App = () => (
        <Section id="render-json">
          <JsonComponent data={{ key: "value" }} />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "render-json");
      const renderer = section!.renderer ?? markdownRenderer;
      const formatted = renderer.format(section!.content);

      expect(formatted.length).toBe(1);
      expect(formatted[0].type).toBe("json");
      expect((formatted[0] as any).data).toEqual({ key: "value" });
    });

    it("should join multiple blocks with double newlines", async () => {
      const App = () => (
        <Section id="render-multi">
          <TextComponent text="First" />
          <TextComponent text="Second" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "render-multi");
      const rendered = renderSectionContent(section!);

      expect(rendered).toBe("First\n\nSecond");
    });
  });

  // ============================================================
  // Timeline Entries
  // ============================================================

  describe("timeline entries", () => {
    it("should collect Entry with role", async () => {
      const App = () => (
        <Message role="user">
          <TextComponent text="User message" />
        </Message>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.timelineEntries.length).toBe(1);
      expect(compiled.timelineEntries[0].role).toBe("user");
    });

    it("should collect Entry with id", async () => {
      const App = () => (
        <Message role="assistant" id="msg-1">
          <TextComponent text="Response" />
        </Message>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.timelineEntries[0].id).toBe("msg-1");
    });

    it("should collect multiple entries in order", async () => {
      const App = () => (
        <>
          <Message role="user">
            <TextComponent text="Hello" />
          </Message>
          <Message role="assistant">
            <TextComponent text="Hi there" />
          </Message>
          <Message role="user">
            <TextComponent text="How are you?" />
          </Message>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.timelineEntries.length).toBe(3);
      expect(compiled.timelineEntries[0].role).toBe("user");
      expect(compiled.timelineEntries[1].role).toBe("assistant");
      expect(compiled.timelineEntries[2].role).toBe("user");
    });

    it("should collect Entry with system role", async () => {
      const App = () => (
        <Message role="system">
          <TextComponent text="You are a helpful assistant." />
        </Message>
      );

      const compiled = await compiler.compile(<App />, tickState);

      // System entries are routed to `compiled.systemEntries` (rebuilt each tick), not timelineEntries
      expect(compiled.systemEntries.length).toBe(1);
      expect(compiled.systemEntries[0].role).toBe("system");
    });

    it("should collect Entry with tool role", async () => {
      const App = () => (
        <Message role="tool">
          <JsonComponent data={{ result: "success" }} />
        </Message>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.timelineEntries[0].role).toBe("tool");
    });
  });

  // ============================================================
  // Tools
  // ============================================================

  describe("tools", () => {
    it("should collect Tool with name and handler", async () => {
      const handler = vi.fn();
      const App = () => <Tool name="get_weather" handler={handler} />;

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.tools.length).toBe(1);
      expect(compiled.tools[0].metadata.name).toBe("get_weather");
      expect(compiled.tools[0].run).toBe(handler);
    });

    it("should collect Tool with description", async () => {
      const App = () => (
        <Tool name="search" description="Search the web for information" handler={() => {}} />
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.tools[0].metadata.description).toBe("Search the web for information");
    });

    it("should collect Tool with schema", async () => {
      const schema = {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      };

      const App = () => <Tool name="search" schema={schema} handler={() => {}} />;

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.tools[0].metadata.input).toEqual(schema);
    });

    it("should collect multiple tools", async () => {
      const App = () => (
        <>
          <Tool name="tool_a" handler={() => "a"} />
          <Tool name="tool_b" handler={() => "b"} />
          <Tool name="tool_c" handler={() => "c"} />
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.tools.length).toBe(3);
      expect(compiled.tools.map((t) => t.metadata.name)).toEqual(["tool_a", "tool_b", "tool_c"]);
    });
  });

  // ============================================================
  // Ephemeral Content
  // ============================================================

  describe("ephemeral content", () => {
    it("should collect Ephemeral content", async () => {
      const App = () => (
        <Ephemeral>
          <TextComponent text="Temporary content" />
        </Ephemeral>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.ephemeral.length).toBe(1);
      expect(compiled.ephemeral[0].content.length).toBe(1);
    });

    it("should collect Ephemeral with position", async () => {
      const App = () => (
        <>
          <Ephemeral position="before">
            <TextComponent text="Before main" />
          </Ephemeral>
          <Ephemeral position="after">
            <TextComponent text="After main" />
          </Ephemeral>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.ephemeral[0].position).toBe("before");
      expect(compiled.ephemeral[1].position).toBe("after");
    });

    it("should collect Ephemeral with order", async () => {
      const App = () => (
        <>
          <Ephemeral order={2}>
            <TextComponent text="Second" />
          </Ephemeral>
          <Ephemeral order={1}>
            <TextComponent text="First" />
          </Ephemeral>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.ephemeral[0].order).toBe(2);
      expect(compiled.ephemeral[1].order).toBe(1);
    });
  });

  // ============================================================
  // Nested Components
  // ============================================================

  describe("nested components", () => {
    it("should collect content from nested custom components", async () => {
      const HeaderSection = () => (
        <Section id="header">
          <TextComponent text="Welcome" />
        </Section>
      );
      const Body = () => (
        <Section id="body">
          <TextComponent text="Main content" />
        </Section>
      );

      const App = () => (
        <>
          <HeaderSection />
          <Body />
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      expect(compiled.sections.size).toBe(2);
      expect(getSection(compiled, "header")).toBeDefined();
      expect(getSection(compiled, "body")).toBeDefined();
    });

    it("should collect deeply nested content", async () => {
      const DeepText = () => <TextComponent text="Deep inside" />;
      const Level2 = () => <DeepText />;
      const Level1 = () => <Level2 />;
      const App = () => (
        <Section id="deep">
          <Level1 />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "deep");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].text).toBe("Deep inside");
    });

    it("should handle conditional content", async () => {
      const showExtra = true;
      const App = () => (
        <Section id="conditional">
          <TextComponent text="Always shown" />
          {showExtra ? <TextComponent text="Conditionally shown" /> : null}
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "conditional");

      expect(section!.content.length).toBe(2);
    });

    it("should handle array mapped content", async () => {
      const items = ["Apple", "Banana", "Cherry"];
      const App = () => (
        <Section id="list">
          {items.map((item, i) => (
            <TextComponent key={i} text={item} />
          ))}
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "list");

      expect(section!.content.length).toBe(3);
      expect(section!.content.map((c) => c.text)).toEqual(items);
    });
  });

  // ============================================================
  // Complete Prompt Assembly
  // ============================================================

  describe("complete prompt assembly", () => {
    it("should compile a realistic agent structure", async () => {
      const toolHandler = vi.fn();

      const App = () => (
        <>
          {/* System prompt */}
          <Section id="system">
            <TextComponent text="You are a helpful assistant." />
          </Section>
          {/* Tools */}
          <Tool
            name="calculate"
            description="Perform calculations"
            schema={{ type: "object", properties: { expression: { type: "string" } } }}
            handler={toolHandler}
          />
          {/* Conversation history */}
          <Message role="user">
            <TextComponent text="What is 2 + 2?" />
          </Message>
          <Message role="assistant">
            <TextComponent text="Let me calculate that for you." />
          </Message>
          {/* Current context */}
          <Section id="context">
            <TextComponent text="Current time: 2024-01-15" />
          </Section>
        </>
      );

      const compiled = await compiler.compile(<App />, tickState);

      // Verify structure
      expect(compiled.sections.size).toBe(2);
      expect(compiled.tools.length).toBe(1);
      expect(compiled.timelineEntries.length).toBe(2);

      // Verify section content
      const systemSection = getSection(compiled, "system");
      expect(renderSectionContent(systemSection!)).toBe("You are a helpful assistant.");

      // Verify tool
      expect(compiled.tools[0].metadata.name).toBe("calculate");
      expect(compiled.tools[0].run).toBe(toolHandler);

      // Verify conversation
      expect(compiled.timelineEntries[0].role).toBe("user");
      expect(compiled.timelineEntries[1].role).toBe("assistant");
    });

    it("should preserve iteration order for model input", async () => {
      const App = () => (
        <Section id="instructions">
          <TextComponent text="Follow these rules:" />
          <TextComponent text="1. Be helpful" />
          <TextComponent text="2. Be concise" />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "instructions");
      const rendered = renderSectionContent(section!);

      // Verify order is preserved
      const lines = rendered.split("\n\n");
      expect(lines[0]).toBe("Follow these rules:");
      expect(lines[1]).toBe("1. Be helpful");
      expect(lines[2]).toBe("2. Be concise");
    });
  });

  // ============================================================
  // Semantic Components
  // ============================================================

  describe("semantic components", () => {
    it("should not OOM when rendering real component imports", async () => {
      // Regression: components were self-referential (h(Self, props) → infinite recursion)
      const App = () => (
        <Section id="safety">
          <TextComponent text="safe" />
          <H1>heading</H1>
          <H2>sub</H2>
          <H3>subsub</H3>
          <Paragraph>para</Paragraph>
          <List>
            <ListItem>item</ListItem>
          </List>
          <Table headers={["a"]} rows={[["b"]]} />
          <Collapsed name="x">summary</Collapsed>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "safety");
      expect(section).toBeDefined();
      expect(section!.content.length).toBeGreaterThan(0);
    });

    it("should collect <Text> children string", async () => {
      const App = () => (
        <Section id="children-text">
          <TextComponent>hello from children</TextComponent>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "children-text");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("text");
      expect(section!.content[0].text).toBe("hello from children");
    });

    it("should collect H1 as heading semantic block", async () => {
      const App = () => (
        <Section id="h1-test">
          <H1>Title</H1>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "h1-test");

      expect(section!.content.length).toBe(1);
      expect(section!.content[0].type).toBe("text");
      expect(section!.content[0].text).toBe("Title");
      expect((section!.content[0] as any).semantic).toEqual({ type: "heading", level: 1 });
    });

    it("should collect H2 and H3 with correct levels", async () => {
      const App = () => (
        <Section id="headings">
          <H2>Sub</H2>
          <H3>SubSub</H3>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "headings");

      expect((section!.content[0] as any).semantic).toEqual({ type: "heading", level: 2 });
      expect((section!.content[1] as any).semantic).toEqual({ type: "heading", level: 3 });
    });

    it("should collect Header with level prop", async () => {
      const App = () => (
        <Section id="header-test">
          <Header level={4}>L4</Header>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "header-test");

      expect((section!.content[0] as any).semantic).toEqual({ type: "heading", level: 4 });
    });

    it("should collect Paragraph as paragraph semantic block", async () => {
      const App = () => (
        <Section id="para-test">
          <Paragraph>A paragraph.</Paragraph>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "para-test");

      expect(section!.content[0].type).toBe("text");
      expect(section!.content[0].text).toBe("A paragraph.");
      expect((section!.content[0] as any).semantic).toEqual({ type: "paragraph" });
    });

    it("should collect List with ListItem children", async () => {
      const App = () => (
        <Section id="list-test">
          <List>
            <ListItem>Apple</ListItem>
            <ListItem>Banana</ListItem>
          </List>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "list-test");

      expect(section!.content.length).toBe(1);
      const block = section!.content[0] as any;
      expect(block.semantic.type).toBe("list");
      expect(block.semantic.structure.ordered).toBe(false);
      expect(block.semantic.structure.items).toEqual(["Apple", "Banana"]);
    });

    it("should collect ordered List", async () => {
      const App = () => (
        <Section id="olist">
          <List ordered>
            <ListItem>First</ListItem>
            <ListItem>Second</ListItem>
          </List>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "olist");
      const block = section!.content[0] as any;

      expect(block.semantic.structure.ordered).toBe(true);
    });

    it("should collect task List with checked items", async () => {
      const App = () => (
        <Section id="tasks">
          <List task>
            <ListItem checked>Done</ListItem>
            <ListItem checked={false}>Not done</ListItem>
          </List>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "tasks");
      const block = section!.content[0] as any;

      expect(block.semantic.structure.task).toBe(true);
      expect(block.semantic.structure.items).toEqual([
        { text: "Done", checked: true },
        { text: "Not done", checked: false },
      ]);
    });

    it("should collect Table with headers/rows props", async () => {
      const App = () => (
        <Section id="table-props">
          <Table headers={["Name", "Age"]} rows={[["Alice", "30"]]} />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "table-props");
      const block = section!.content[0] as any;

      expect(block.semantic.type).toBe("table");
      expect(block.semantic.structure.headers).toEqual(["Name", "Age"]);
      expect(block.semantic.structure.rows).toEqual([["Alice", "30"]]);
    });

    it("should collect Table with Row/Column children", async () => {
      const App = () => (
        <Section id="table-children">
          <Table>
            <Row header>
              <Column>Name</Column>
              <Column>Age</Column>
            </Row>
            <Row>
              <Column>Bob</Column>
              <Column>25</Column>
            </Row>
          </Table>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "table-children");
      const block = section!.content[0] as any;

      expect(block.semantic.type).toBe("table");
      expect(block.semantic.structure.headers).toEqual(["Name", "Age"]);
      expect(block.semantic.structure.rows).toEqual([["Bob", "25"]]);
    });

    it("should collect Collapsed with name and group", async () => {
      const App = () => (
        <Section id="collapsed-test">
          <Collapsed name="details" group="info">
            Click to expand
          </Collapsed>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "collapsed-test");

      const block = section!.content[0] as any;
      expect(block.type).toBe("text");
      expect(block.text).toBe("Click to expand");
      expect(block.semantic.type).toBe("custom");
      expect(block.semantic.rendererTag).toBe("collapsed");
      expect(block.semantic.rendererAttrs).toEqual({ name: "details", group: "info" });
    });

    it("should render heading semantic block as markdown", async () => {
      const App = () => (
        <Section id="md-heading">
          <H1>Title</H1>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "md-heading");
      const rendered = renderSectionContent(section!);

      expect(rendered).toBe("# Title");
    });

    it("should render list semantic block as markdown", async () => {
      const App = () => (
        <Section id="md-list">
          <List>
            <ListItem>A</ListItem>
            <ListItem>B</ListItem>
          </List>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "md-list");
      const rendered = renderSectionContent(section!);

      expect(rendered).toBe("- A\n- B");
    });

    it("should render table semantic block as markdown", async () => {
      const App = () => (
        <Section id="md-table">
          <Table headers={["X"]} rows={[["1"]]} />
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "md-table");
      const rendered = renderSectionContent(section!);

      expect(rendered).toContain("| X");
      expect(rendered).toContain("| 1");
    });

    it("should render collapsed as XML tags", async () => {
      const App = () => (
        <Section id="md-collapsed">
          <Collapsed name="x">summary</Collapsed>
        </Section>
      );

      const compiled = await compiler.compile(<App />, tickState);
      const section = getSection(compiled, "md-collapsed");
      const rendered = renderSectionContent(section!);

      expect(rendered).toBe('<collapsed name="x">summary</collapsed>');
    });
  });

  // TODO: Test <Event><UserAction>/<SystemEvent>/<StateChange></Event> → timeline entry pipeline.
  // The collector handles event block components as section children (tested above),
  // but the full <Event> parent → timeline entry flow with event block children is untested.
});
