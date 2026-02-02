import {
  Telemetry,
  type TelemetryProvider,
  type Span,
  type Counter,
  type Histogram,
} from "./telemetry";

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
