import {
  Telemetry,
  type TelemetryProvider,
  type Span,
  type Counter,
  type Histogram,
  type SpanStatus,
  type AttributeValue,
} from "./telemetry.js";

class MockTelemetryProvider implements TelemetryProvider {
  spans: string[] = [];
  errors: any[] = [];
  counters: Record<string, number> = {};
  histograms: Record<string, number[]> = {};

  startTrace(name: string): string {
    return `mock-trace-${name}`;
  }

  startSpan(name: string): Span {
    this.spans.push(name);
    return {
      end: () => {},
      setAttribute: () => {},
      recordError: (err) => this.errors.push(err),
    };
  }

  recordError(error: any): void {
    this.errors.push(error);
  }

  endTrace(): void {}

  getCounter(name: string): Counter {
    return {
      add: (val) => {
        this.counters[name] = (this.counters[name] || 0) + val;
      },
    };
  }

  getHistogram(name: string): Histogram {
    return {
      record: (val) => {
        if (!this.histograms[name]) this.histograms[name] = [];
        this.histograms[name].push(val);
      },
    };
  }
}

describe("Kernel Telemetry", () => {
  let mockProvider: MockTelemetryProvider;

  beforeEach(() => {
    mockProvider = new MockTelemetryProvider();
    Telemetry.setProvider(mockProvider);
  });

  afterEach(() => {
    Telemetry.resetProvider();
  });

  it("should delegate startSpan to provider", () => {
    Telemetry.startSpan("test-span");
    expect(mockProvider.spans).toContain("test-span");
  });

  it("should delegate recordError to provider", () => {
    const err = new Error("test error");
    Telemetry.recordError(err);
    expect(mockProvider.errors).toContain(err);
  });

  it("should delegate metrics to provider", () => {
    const counter = Telemetry.getCounter("requests");
    counter.add(1);
    counter.add(5);

    expect(mockProvider.counters["requests"]).toBe(6);

    const histogram = Telemetry.getHistogram("latency");
    histogram.record(100);
    histogram.record(200);

    expect(mockProvider.histograms["latency"]).toEqual([100, 200]);
  });
});

describe("NoOpProvider span", () => {
  beforeEach(() => Telemetry.resetProvider());
  afterEach(() => Telemetry.resetProvider());

  it("returns a span that satisfies the full Span interface as no-ops", () => {
    const span = Telemetry.startSpan("anything");

    // Required methods exist and don't throw.
    expect(() => span.setAttribute("k", "v")).not.toThrow();
    expect(() => span.recordError(new Error("x"))).not.toThrow();
    expect(() => span.end()).not.toThrow();

    // Optional methods exist on NoOp and behave as expected.
    expect(span.isRecording?.()).toBe(false);
    expect(span.getAttribute?.("missing")).toBeUndefined();
    expect(span.getAttributes?.()).toEqual({});
    expect(() => span.setAttributes?.({ a: 1, b: "two" })).not.toThrow();
    expect(() => span.addEvent?.("event-1", { ok: true })).not.toThrow();
    expect(() => span.setStatus?.({ code: "error", message: "oops" } as SpanStatus)).not.toThrow();
    expect(() => span.updateName?.("new-name")).not.toThrow();
  });
});

describe("Span interface — provider with full feature support", () => {
  /**
   * Reference implementation for the expanded Span interface. Verifies the
   * round-trip behavior callers should expect: attributes set are readable,
   * events accumulate, status is overridable, identity is exposed.
   */
  class FullProvider implements TelemetryProvider {
    spans: ReturnType<FullProvider["buildSpan"]>[] = [];

    startTrace(): string {
      return "trace-x";
    }

    startSpan(name: string): Span {
      const built = this.buildSpan(name);
      this.spans.push(built);
      return built.span;
    }

    recordError(): void {}
    endTrace(): void {}
    getCounter(): Counter {
      return { add: () => {} };
    }
    getHistogram(): Histogram {
      return { record: () => {} };
    }

    private buildSpan(name: string) {
      const attrs: Record<string, AttributeValue> = {};
      const events: { name: string; attrs?: Record<string, AttributeValue> }[] = [];
      const state = {
        name,
        ended: false,
        status: { code: "unset", message: undefined } as SpanStatus,
        error: null as unknown,
      };
      const span: Span = {
        traceId: "trace-x",
        spanId: `span-${name}`,
        end: () => {
          state.ended = true;
        },
        isRecording: () => !state.ended,
        updateName: (n) => {
          state.name = n;
        },
        setAttribute: (k, v) => {
          attrs[k] = v as AttributeValue;
        },
        setAttributes: (next) => {
          for (const [k, v] of Object.entries(next)) attrs[k] = v;
        },
        getAttribute: (k) => attrs[k],
        getAttributes: () => Object.freeze({ ...attrs }),
        addEvent: (n, a) => events.push({ name: n, attrs: a }),
        setStatus: (s) => {
          state.status = s;
        },
        recordError: (err) => {
          state.error = err;
          state.status = { code: "error", message: (err as Error)?.message };
        },
      };
      return { span, state, attrs, events };
    }
  }

  let provider: FullProvider;

  beforeEach(() => {
    provider = new FullProvider();
    Telemetry.setProvider(provider);
  });

  afterEach(() => Telemetry.resetProvider());

  it("exposes traceId and spanId on the returned span", () => {
    const span = Telemetry.startSpan("foo");
    expect(span.traceId).toBe("trace-x");
    expect(span.spanId).toBe("span-foo");
  });

  it("isRecording flips to false after end", () => {
    const span = Telemetry.startSpan("foo");
    expect(span.isRecording?.()).toBe(true);
    span.end();
    expect(span.isRecording?.()).toBe(false);
  });

  it("setAttributes accepts a record and stores values", () => {
    const span = Telemetry.startSpan("foo");
    span.setAttributes?.({ a: 1, b: "two", c: true });
    expect(span.getAttribute?.("a")).toBe(1);
    expect(span.getAttribute?.("b")).toBe("two");
    expect(span.getAttribute?.("c")).toBe(true);
  });

  it("getAttributes returns a snapshot of all set attributes", () => {
    const span = Telemetry.startSpan("foo");
    span.setAttribute("x", 1);
    span.setAttribute("y", 2);
    expect(span.getAttributes?.()).toEqual({ x: 1, y: 2 });
  });

  it("setAttribute then read-back enables non-clobbering enrichment", () => {
    const span = Telemetry.startSpan("foo");
    span.setAttribute("tool.name", "engine-set");
    if (span.getAttribute?.("tool.name") === undefined) {
      span.setAttribute("tool.name", "would-clobber");
    }
    expect(span.getAttribute?.("tool.name")).toBe("engine-set");
  });

  it("addEvent records named events with optional attributes", () => {
    const span = Telemetry.startSpan("foo");
    span.addEvent?.("a", { phase: "start" });
    span.addEvent?.("b");
    const events = provider.spans[0].events;
    expect(events).toEqual([
      { name: "a", attrs: { phase: "start" } },
      { name: "b", attrs: undefined },
    ]);
  });

  it("setStatus overrides the implicit status from recordError", () => {
    const span = Telemetry.startSpan("foo");
    span.recordError(new Error("boom"));
    expect(provider.spans[0].state.status.code).toBe("error");
    span.setStatus?.({ code: "ok" });
    expect(provider.spans[0].state.status.code).toBe("ok");
  });

  it("updateName mutates the span name", () => {
    const span = Telemetry.startSpan("http.request");
    span.updateName?.("POST /v1/query");
    expect(provider.spans[0].state.name).toBe("POST /v1/query");
  });
});
