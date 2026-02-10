/**
 * Duplicate Message Prevention Tests
 *
 * These tests verify that messages sent via session.send() are NOT
 * duplicated in the model's input. This was a bug where:
 * 1. compileTick added queued messages to COM timeline
 * 2. <Timeline> rendered those messages as <User> components
 * 3. The structure renderer added them AGAIN
 *
 * The fix ensures messages only get added once via the JSX rendering path.
 */

import { describe, it, expect } from "vitest";
import { createApp, Model, System, Timeline } from "../../index";
import { createTestAdapter } from "../../testing/test-adapter";
import type { Message, TextBlock } from "@agentick/shared";
import { isTextBlock } from "@agentick/shared/blocks";

describe("Duplicate Message Prevention", () => {
  describe("First tick - single user message", () => {
    it("should NOT duplicate user message on first tick", async () => {
      const mockModel = createTestAdapter({
        defaultResponse: "Test response",
      });

      const Agent = () => {
        return (
          <>
            <Model model={mockModel} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello world" }],
          },
        ],
      }).result;

      // Check the input sent to the model
      const inputs = mockModel.getCapturedInputs();
      expect(inputs.length).toBeGreaterThanOrEqual(1);

      const lastInput = inputs[inputs.length - 1];
      const userMessages = (lastInput.messages as Message[]).filter(
        (e: Message) => e?.role === "user",
      );

      // Should have exactly ONE user message, not duplicated
      expect(userMessages.length).toBe(1);
      expect(isTextBlock(userMessages[0].content[0])).toBe(true);
      expect((userMessages[0].content[0] as TextBlock).text).toBe("Hello world");

      await session.close();
    });
  });

  describe("Subsequent ticks - conversation flow", () => {
    it("should NOT duplicate messages across multiple exchanges", async () => {
      const mockModel = createTestAdapter();

      const Agent = () => {
        return (
          <>
            <Model model={mockModel} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First message
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "First message" }],
          },
        ],
      }).result;

      mockModel.clearCapturedInputs();

      // Second message
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Second message" }],
          },
        ],
      }).result;

      // Check the input for the second execution
      const inputs = mockModel.getCapturedInputs();
      expect(inputs.length).toBeGreaterThanOrEqual(1);

      const lastInput = inputs[inputs.length - 1];

      // Count user messages - should have 2 (first + second), each appearing once
      const userMessages = (lastInput.messages as Message[]).filter(
        (e: Message) => e?.role === "user",
      );

      // Count messages by content
      const firstCount = userMessages.filter(
        ({ content }) => isTextBlock(content[0]) && content[0].text === "First message",
      ).length;
      const secondCount = userMessages.filter(
        ({ content }) => isTextBlock(content[0]) && content[0].text === "Second message",
      ).length;

      expect(firstCount).toBe(1); // First message appears once
      expect(secondCount).toBe(1); // Second message appears once

      await session.close();
    });

    it("should NOT duplicate assistant messages", async () => {
      const mockModel = createTestAdapter();

      const Agent = () => {
        return (
          <>
            <Model model={mockModel} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // First exchange
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
      }).result;

      mockModel.clearCapturedInputs();

      // Second message - should see previous assistant response exactly once
      await session.send({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Followup" }],
          },
        ],
      }).result;

      const inputs = mockModel.getCapturedInputs();
      expect(inputs.length).toBeGreaterThanOrEqual(1);

      const lastInput = inputs[inputs.length - 1];
      const assistantMessages = (lastInput.messages as Message[]).filter(
        (e: Message) => e?.role === "assistant",
      );

      // Each assistant response should appear exactly once
      // Note: There may be 2 distinct assistant messages if tool loops happened
      // But same message content should NOT be duplicated
      const responseTexts = assistantMessages.map((e: Message) =>
        e.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join(""),
      );

      // Count occurrences of each text
      const textCounts = new Map<string, number>();
      for (const text of responseTexts) {
        textCounts.set(text, (textCounts.get(text) || 0) + 1);
      }

      // Each unique text should appear exactly once
      for (const [_text, count] of textCounts) {
        expect(count).toBe(1);
      }

      await session.close();
    });
  });

  describe("Multiple exchanges - history preservation", () => {
    it("should handle 5 consecutive exchanges without duplication", async () => {
      const mockModel = createTestAdapter();

      const Agent = () => {
        return (
          <>
            <Model model={mockModel} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // Send 5 messages
      for (let i = 1; i <= 5; i++) {
        await session.send({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: `Message ${i}` }],
            },
          ],
        }).result;
      }

      // Get the last captured input
      const inputs = mockModel.getCapturedInputs();
      const lastInput = inputs[inputs.length - 1];

      const userMsgs = (lastInput.messages as Message[]).filter((e: Message) => e?.role === "user");
      const assistantMsgs = (lastInput.messages as Message[]).filter(
        (e: Message) => e?.role === "assistant",
      );

      // Should have exactly 5 user messages
      expect(userMsgs.length).toBe(5);

      // Should have 4 assistant responses (from messages 1-4)
      // Note: Mock returns same "Response" text each time, but they're distinct messages
      expect(assistantMsgs.length).toBe(4);

      // Verify each user message appears exactly once
      for (let i = 1; i <= 5; i++) {
        const count = userMsgs.filter(
          (e: Message) =>
            isTextBlock(e.content[0]) && (e.content[0] as TextBlock).text === `Message ${i}`,
        ).length;
        expect(count).toBe(1);
      }

      await session.close();
    });

    it("should preserve all messages across 3 exchanges", async () => {
      const mockModel = createTestAdapter();

      const Agent = () => {
        return (
          <>
            <Model model={mockModel} />
            <System>Test</System>
            <Timeline />
          </>
        );
      };

      const app = createApp(Agent, { maxTicks: 1 });
      const session = await app.session();

      // Exchange 1
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }).result;

      // Exchange 2
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "How are you?" }] }],
      }).result;

      // Exchange 3
      await session.send({
        messages: [{ role: "user", content: [{ type: "text", text: "Goodbye" }] }],
      }).result;

      const inputs = mockModel.getCapturedInputs();
      const lastInput = inputs[inputs.length - 1];

      // Verify complete history
      const userMsgs = (lastInput.messages as Message[]).filter((e: Message) => e?.role === "user");
      const assistantMsgs = (lastInput.messages as Message[]).filter(
        (e: Message) => e?.role === "assistant",
      );

      expect(userMsgs.length).toBe(3); // 3 user messages
      expect(assistantMsgs.length).toBe(2); // 2 assistant responses (from exchanges 1 and 2)

      // Verify no duplicates - each user message appears exactly once
      const userTexts = userMsgs.map((e: Message) =>
        isTextBlock(e.content[0]) ? (e.content[0] as TextBlock).text : "",
      );
      expect(userTexts).toContain("Hello");
      expect(userTexts).toContain("How are you?");
      expect(userTexts).toContain("Goodbye");
      expect(userTexts.filter((t: string) => t === "Hello").length).toBe(1);
      expect(userTexts.filter((t: string) => t === "How are you?").length).toBe(1);
      expect(userTexts.filter((t: string) => t === "Goodbye").length).toBe(1);

      await session.close();
    });
  });
});
