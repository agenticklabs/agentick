import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { flush } from "../../../testing.js";
import { StatusBarContext, type StatusBarData } from "../context.js";
import { StatusBarRight } from "../StatusBarRight.js";
import { ModelInfo } from "./ModelInfo.js";
import { TokenCount } from "./TokenCount.js";
import { TickCount } from "./TickCount.js";
import { ContextUtilization } from "./ContextUtilization.js";
import { StateIndicator } from "./StateIndicator.js";
import { KeyboardHints } from "./KeyboardHints.js";
import { BrandLabel } from "./BrandLabel.js";
import { Separator } from "./Separator.js";

const baseData: StatusBarData = {
  mode: "idle",
  isExecuting: false,
  sessionId: "test-session",
  contextInfo: {
    modelId: "gpt-4o",
    modelName: "GPT-4o",
    inputTokens: 1200,
    outputTokens: 300,
    totalTokens: 1500,
    utilization: 35,
    tick: 2,
    cumulativeUsage: {
      inputTokens: 5000,
      outputTokens: 1200,
      totalTokens: 6200,
      ticks: 3,
    },
  },
};

function Wrapper({ data, children }: { data: StatusBarData; children: React.ReactNode }) {
  return (
    <StatusBarContext value={data}>
      <Box>{children}</Box>
    </StatusBarContext>
  );
}

describe("ModelInfo", () => {
  it("shows model name from context", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <ModelInfo />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("GPT-4o");
  });

  it("shows explicit modelName over context", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <ModelInfo modelName="Custom Model" />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("Custom Model");
  });

  it("falls back to modelId when no modelName", async () => {
    const data = {
      ...baseData,
      contextInfo: { ...baseData.contextInfo!, modelName: undefined },
    };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <ModelInfo />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("gpt-4o");
  });

  it("shows dash when no context info", async () => {
    const data = { ...baseData, contextInfo: null };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <ModelInfo />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("\u2014");
  });
});

describe("TokenCount", () => {
  it("shows cumulative tokens by default", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <TokenCount />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("6.2K");
  });

  it("shows per-tick tokens when cumulative=false", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <TokenCount cumulative={false} />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("1.5K");
  });

  it("shows explicit tokens", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <TokenCount tokens={42000} />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("42.0K");
  });

  it("shows label prefix", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <TokenCount tokens={500} label="tokens:" />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("tokens: 500");
  });

  it("returns null when count is 0", async () => {
    const data = { ...baseData, contextInfo: null };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <TokenCount />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame.trim()).toBe("");
  });
});

describe("TickCount", () => {
  it("shows tick number from context", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <TickCount />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("tick 2");
  });

  it("shows explicit tick", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <TickCount tick={7} />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("tick 7");
  });

  it("returns null when tick is 0", async () => {
    const data = {
      ...baseData,
      contextInfo: { ...baseData.contextInfo!, tick: 0 },
    };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <TickCount />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame.trim()).toBe("");
  });

  it("returns null when no context info", async () => {
    const data = { ...baseData, contextInfo: null };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <TickCount />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame.trim()).toBe("");
  });
});

describe("ContextUtilization", () => {
  it("shows utilization percentage", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <ContextUtilization />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("35%");
  });

  it("returns null when no utilization", async () => {
    const data = {
      ...baseData,
      contextInfo: { ...baseData.contextInfo!, utilization: undefined },
    };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <ContextUtilization />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame.trim()).toBe("");
  });

  it("uses explicit utilization", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <ContextUtilization utilization={72} />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("72%");
  });
});

describe("StateIndicator", () => {
  it("shows idle state", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <StateIndicator />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("idle");
  });

  it("shows streaming state", async () => {
    const data = { ...baseData, mode: "streaming" as const };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <StateIndicator />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("streaming");
  });

  it("uses custom labels", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <StateIndicator labels={{ idle: "ready" }} />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("ready");
  });

  it("uses explicit mode over context", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <StateIndicator mode="confirming_tool" />
      </Wrapper>,
    );
    await flush();
    expect(lastFrame()).toContain("confirm");
  });
});

describe("KeyboardHints", () => {
  it("shows idle hints by default", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <KeyboardHints />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Enter");
    expect(frame).toContain("send");
    expect(frame).toContain("Ctrl+C");
    expect(frame).toContain("exit");
  });

  it("shows streaming hints", async () => {
    const data = { ...baseData, mode: "streaming" as const };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <KeyboardHints />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Ctrl+C");
    expect(frame).toContain("abort");
  });

  it("shows confirm hints", async () => {
    const data = { ...baseData, mode: "confirming_tool" as const };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <KeyboardHints />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Y");
    expect(frame).toContain("approve");
    expect(frame).toContain("N");
    expect(frame).toContain("reject");
  });

  it("uses custom hints", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <KeyboardHints hints={{ idle: [{ key: "Tab", action: "complete" }] }} />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("Tab");
    expect(frame).toContain("complete");
  });
});

describe("BrandLabel", () => {
  it("shows default name", async () => {
    const { lastFrame } = render(<BrandLabel />);
    await flush();
    expect(lastFrame()).toContain("agentick");
  });

  it("shows custom name", async () => {
    const { lastFrame } = render(<BrandLabel name="tentickle" />);
    await flush();
    expect(lastFrame()).toContain("tentickle");
  });
});

describe("Separator", () => {
  it("renders default pipe", async () => {
    const { lastFrame } = render(<Separator />);
    await flush();
    expect(lastFrame()).toContain("|");
  });

  it("renders custom character", async () => {
    const { lastFrame } = render(<Separator char="·" />);
    await flush();
    expect(lastFrame()).toContain("·");
  });
});

describe("StatusBarRight (responsive)", () => {
  it("shows all segments at wide width (100+)", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <StatusBarRight width={120} />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("GPT-4o");
    expect(frame).toContain("6.2K");
    expect(frame).toContain("35%");
    expect(frame).toContain("idle");
  });

  it("shows model + state at medium width (60-79)", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <StatusBarRight width={70} />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain("GPT-4o");
    expect(frame).not.toContain("6.2K");
    expect(frame).toContain("idle");
  });

  it("shows only state at narrow width (<60)", async () => {
    const { lastFrame } = render(
      <Wrapper data={baseData}>
        <StatusBarRight width={50} />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).not.toContain("GPT-4o");
    expect(frame).not.toContain("6.2K");
    expect(frame).toContain("idle");
  });

  it("handles no context info gracefully", async () => {
    const data = { ...baseData, contextInfo: null };
    const { lastFrame } = render(
      <Wrapper data={data}>
        <StatusBarRight width={120} />
      </Wrapper>,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).not.toContain("|");
    expect(frame).toContain("idle");
  });
});
