import { describe, it, expect, afterEach } from "vitest";
import { Expandable } from "../../hooks";
import { Knobs } from "../../hooks";
import { compileAgent, createTestAdapter, renderAgent, cleanup } from "../../testing";
import { Message, Timeline } from "../../jsx/components/primitives";
import { Collapsed } from "../../jsx/components/collapsed";
import { extractText } from "@agentick/shared";

afterEach(cleanup);

describe("Expandable", () => {
  it("registers set_knob tool", async () => {
    function Agent() {
      return (
        <>
          <Expandable name="test-expand" summary="Test">
            {(expanded) => (expanded ? "Full" : "Summary")}
          </Expandable>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    expect(result.hasTool("set_knob")).toBe(true);
  });

  it("renders collapsed state by default", async () => {
    function Agent() {
      return (
        <>
          <Message role="user">
            <Expandable name="exp:0" summary="[collapsed]">
              {(expanded, name) =>
                expanded ? "Full content" : <Collapsed name={name}>[collapsed]</Collapsed>
              }
            </Expandable>
          </Message>
          <Knobs />
        </>
      );
    }

    const result = await compileAgent(Agent);
    const blocks = result.compiled.timelineEntries[0].content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("[collapsed]");
  });

  it("passes effective name to render function", async () => {
    let capturedName: string | undefined;

    function Agent() {
      return (
        <>
          <Message role="user">
            <Expandable summary="test">
              {(_expanded, name) => {
                capturedName = name;
                return "content";
              }}
            </Expandable>
          </Message>
          <Knobs />
        </>
      );
    }

    await compileAgent(Agent);
    expect(capturedName).toBeDefined();
    expect(capturedName).toMatch(/^_expand_\d+$/);
  });

  it("uses explicit name when provided", async () => {
    let capturedName: string | undefined;

    function Agent() {
      return (
        <>
          <Message role="user">
            <Expandable name="my-name" summary="test">
              {(_expanded, name) => {
                capturedName = name;
                return "content";
              }}
            </Expandable>
          </Message>
          <Knobs />
        </>
      );
    }

    await compileAgent(Agent);
    expect(capturedName).toBe("my-name");
  });

  it("expands when model calls set_knob", async () => {
    const model = createTestAdapter({ defaultResponse: "Done" });
    model.respondWith([{ tool: { name: "set_knob", input: { name: "exp:0", value: true } } }]);

    function Agent() {
      return (
        <>
          <Model model={model} />
          <Timeline />
          <Message role="user">
            <Expandable name="exp:0" summary="[summary]">
              {(expanded, name) =>
                expanded ? "EXPANDED CONTENT" : <Collapsed name={name}>[summary]</Collapsed>
              }
            </Expandable>
          </Message>
          <Knobs />
        </>
      );
    }

    // Need Model import
    const { Model } = await import("../../jsx/components/model");

    const { send, unmount } = await renderAgent(Agent, {
      model,
      appOptions: { maxTicks: 5 },
    });

    await send("Expand it");

    const inputs = model.getCapturedInputs();
    const allText = inputs
      .flatMap((i: any) => i.messages)
      .map((m: any) => extractText(m.content, ""))
      .join(" ");
    expect(allText).toContain("EXPANDED CONTENT");

    await unmount();
  });
});
