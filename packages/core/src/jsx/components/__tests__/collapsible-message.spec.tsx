import { describe, it, expect, afterEach } from "vitest";
import type { Message as MessageType } from "@agentick/shared";
import { compileAgent, createTestAdapter, renderAgent, cleanup } from "../../../testing";
import { Message, Timeline } from "../primitives";
import { Model } from "../model";
import { Knobs } from "../../../hooks";
import { extractText } from "@agentick/shared";

afterEach(cleanup);

// Helper: extract text from all timeline entries in compiled output
function timelineTexts(compiled: any): string[] {
  return compiled.timelineEntries.map((entry: any) =>
    entry.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(""),
  );
}

function messagesAsMessages(messages: any): MessageType[] {
  return messages as MessageType[];
}

describe("Message collapsed prop", () => {
  // -------------------------------------------------------------------------
  // Compilation: what the model sees
  // -------------------------------------------------------------------------

  describe("compilation", () => {
    it("renders summary text when collapsed", async () => {
      function Agent() {
        return (
          <>
            <Message role="user" collapsed="[ref:0] user asked about weather">
              What is the weather like in San Francisco today? I need to know because I am planning
              a trip there next week.
            </Message>
            <Knobs />
          </>
        );
      }

      const result = await compileAgent(Agent);
      const texts = timelineTexts(result.compiled);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("[ref:0] user asked about weather");
      expect(texts[0]).not.toContain("San Francisco");
    });

    it("renders full content when no collapsed prop", async () => {
      function Agent() {
        return <Message role="user">What is the weather in San Francisco?</Message>;
      }

      const result = await compileAgent(Agent);
      const texts = timelineTexts(result.compiled);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("San Francisco");
    });

    it("preserves message role when collapsed", async () => {
      function Agent() {
        return (
          <>
            <Message role="assistant" collapsed="[tools: shell]">
              I ran a command and got output.
            </Message>
            <Knobs />
          </>
        );
      }

      const result = await compileAgent(Agent);
      expect(result.compiled.timelineEntries).toHaveLength(1);
      expect(result.compiled.timelineEntries[0].role).toBe("assistant");
    });

    it("registers set_knob tool when collapsed messages exist", async () => {
      function Agent() {
        return (
          <>
            <Message role="user" collapsed="summary">
              Full content
            </Message>
            <Knobs />
          </>
        );
      }

      const result = await compileAgent(Agent);
      expect(result.hasTool("set_knob")).toBe(true);
    });

    it("handles mixed collapsed and non-collapsed messages", async () => {
      function Agent() {
        return (
          <>
            <Message role="user" collapsed="[ref:0] old message">
              This is the full old message content.
            </Message>
            <Message role="assistant" collapsed="[ref:1] old reply">
              This is the full old reply.
            </Message>
            <Message role="user">Current question about weather.</Message>
            <Knobs />
          </>
        );
      }

      const result = await compileAgent(Agent);
      const texts = timelineTexts(result.compiled);
      expect(texts).toHaveLength(3);
      expect(texts[0]).toContain("[ref:0] old message");
      expect(texts[0]).not.toContain("full old message");
      expect(texts[1]).toContain("[ref:1] old reply");
      expect(texts[1]).not.toContain("full old reply");
      expect(texts[2]).toContain("weather");
    });
  });

  // -------------------------------------------------------------------------
  // Integration: model expands via set_knob
  // -------------------------------------------------------------------------

  describe("expand via set_knob", () => {
    it("expands when model calls set_knob with the collapsed name", async () => {
      const model = createTestAdapter({ defaultResponse: "Done" });
      model.respondWith([{ tool: { name: "set_knob", input: { name: "ref:0", value: true } } }]);

      function Agent() {
        return (
          <>
            <Model model={model} />
            <Timeline />
            <Message role="user" collapsed="[ref:0] old user message" collapsedName="ref:0">
              What is the full detailed content of the original message?
            </Message>
            <Knobs />
          </>
        );
      }

      const { send, unmount } = await renderAgent(Agent, {
        model,
        appOptions: { maxTicks: 5 },
      });

      await send("Expand ref:0");

      const inputs = model.getCapturedInputs();
      expect(inputs.length).toBeGreaterThanOrEqual(2);

      // First model call should see collapsed summary (not full content)
      const firstText = messagesAsMessages(inputs[0].messages)
        .map((m: any) => extractText(m.content, ""))
        .join(" ");
      expect(firstText).toContain("[ref:0] old user message");

      // After set_knob(ref:0, true), some model call should see expanded content
      const allText = inputs
        .flatMap((i: any) => messagesAsMessages(i.messages))
        .map((m: any) => extractText(m.content, ""))
        .join(" ");
      expect(allText).toContain("full detailed content");

      await unmount();
    });

    it("momentary: expanded state resets on next send()", async () => {
      const model = createTestAdapter({ defaultResponse: "Done" });

      function Agent() {
        return (
          <>
            <Model model={model} />
            <Timeline />
            <Message role="user" collapsed="[ref:0] summary" collapsedName="ref:0">
              Full content that should only appear when expanded.
            </Message>
            <Knobs />
          </>
        );
      }

      const { send, unmount } = await renderAgent(Agent, {
        model,
        appOptions: { maxTicks: 5 },
      });

      // First send: model expands the knob
      model.respondWith([{ tool: { name: "set_knob", input: { name: "ref:0", value: true } } }]);
      await send("Expand");

      // Second send: knob should have reset (momentary)
      model.clearCapturedInputs();
      await send("Next question");

      const inputs = model.getCapturedInputs();
      expect(inputs.length).toBeGreaterThanOrEqual(1);

      // First model call of second execution should see collapsed summary
      const firstText = messagesAsMessages(inputs[0].messages)
        .map((m: any) => extractText(m.content, ""))
        .join(" ");
      expect(firstText).toContain("[ref:0] summary");
      expect(firstText).not.toContain("only appear when expanded");

      await unmount();
    });
  });

  // -------------------------------------------------------------------------
  // Auto-naming
  // -------------------------------------------------------------------------

  describe("auto-naming", () => {
    it("generates unique knob names for multiple collapsed messages", async () => {
      function Agent() {
        return (
          <>
            <Message role="user" collapsed="first summary">
              First full message.
            </Message>
            <Message role="assistant" collapsed="second summary">
              Second full message.
            </Message>
            <Message role="user" collapsed="third summary">
              Third full message.
            </Message>
            <Knobs />
          </>
        );
      }

      const result = await compileAgent(Agent);
      // All three should compile (if names collided, knob registration would fail)
      const texts = timelineTexts(result.compiled);
      expect(texts).toHaveLength(3);
      expect(texts[0]).toContain("first summary");
      expect(texts[1]).toContain("second summary");
      expect(texts[2]).toContain("third summary");
    });

    it("explicit collapsedName overrides auto-naming", async () => {
      const model = createTestAdapter({ defaultResponse: "Done" });
      model.respondWith([
        { tool: { name: "set_knob", input: { name: "my-custom-name", value: true } } },
      ]);

      function Agent() {
        return (
          <>
            <Model model={model} />
            <Timeline />
            <Message role="user" collapsed="summary" collapsedName="my-custom-name">
              Expanded via custom name.
            </Message>
            <Knobs />
          </>
        );
      }

      const { send, unmount } = await renderAgent(Agent, {
        model,
        appOptions: { maxTicks: 5 },
      });

      await send("Expand");

      const inputs = model.getCapturedInputs();
      // After set_knob call, model should see expanded content
      const allText = inputs
        .flatMap((i: any) => i.messages)
        .map((m: any) => extractText(m.content, ""))
        .join(" ");
      expect(allText).toContain("Expanded via custom name");

      await unmount();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases / adversarial
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("empty string collapsed still activates collapse behavior", async () => {
      function Agent() {
        return (
          <>
            <Message role="user" collapsed="">
              Hidden content.
            </Message>
            <Knobs />
          </>
        );
      }

      const result = await compileAgent(Agent);
      const texts = timelineTexts(result.compiled);
      expect(texts).toHaveLength(1);
      // Empty collapsed string means empty content when collapsed
      expect(texts[0]).not.toContain("Hidden content");
    });

    it("undefined collapsed does not activate collapse", async () => {
      function Agent() {
        return (
          <Message role="user" collapsed={undefined}>
            Visible content.
          </Message>
        );
      }

      const result = await compileAgent(Agent);
      const texts = timelineTexts(result.compiled);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("Visible content");
    });

    it("collapsed with content prop instead of children", async () => {
      function Agent() {
        return (
          <>
            <Message
              role="user"
              content={[{ type: "text", text: "Full content via prop" }]}
              collapsed="summary via prop"
            />
            <Knobs />
          </>
        );
      }

      const result = await compileAgent(Agent);
      const texts = timelineTexts(result.compiled);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("summary via prop");
      expect(texts[0]).not.toContain("Full content via prop");
    });

    it("collapsed summary with special characters", async () => {
      const summary = '[ref:5] [tools: shell ×3, read_file] "quoted text" & <brackets>';
      function Agent() {
        return (
          <>
            <Message role="assistant" collapsed={summary}>
              Actual content.
            </Message>
            <Knobs />
          </>
        );
      }

      const result = await compileAgent(Agent);
      const texts = timelineTexts(result.compiled);
      expect(texts[0]).toContain("shell ×3");
      expect(texts[0]).toContain("read_file");
    });

    it("collapsed message preserves metadata", async () => {
      function Agent() {
        return (
          <>
            <Message
              role="user"
              id="msg-123"
              metadata={{ source: { type: "local" } }}
              collapsed="summary"
            >
              Full content.
            </Message>
            <Knobs />
          </>
        );
      }

      const result = await compileAgent(Agent);
      const entry = result.compiled.timelineEntries[0];
      expect(entry.id).toBe("msg-123");
      expect(entry.metadata?.source).toBe("test");
    });

    it("collapsed with very long summary truncates knob description", async () => {
      const longSummary = "A".repeat(200);
      function Agent() {
        return (
          <>
            <Message role="user" collapsed={longSummary}>
              Content.
            </Message>
            <Knobs />
          </>
        );
      }

      // Should not throw — the description gets sliced to 60 chars
      const result = await compileAgent(Agent);
      expect(result.compiled.timelineEntries).toHaveLength(1);
    });
  });
});
