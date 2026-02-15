import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeliveryBuffer, RateLimiter } from "../delivery-buffer.js";

describe("DeliveryBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("immediate strategy", () => {
    it("delivers on every poke", () => {
      const onDeliver = vi.fn();
      const buffer = new DeliveryBuffer({ strategy: "immediate", debounceMs: 0, onDeliver });

      buffer.poke();
      expect(onDeliver).toHaveBeenCalledTimes(1);

      buffer.poke();
      expect(onDeliver).toHaveBeenCalledTimes(2);

      buffer.destroy();
    });
  });

  describe("on-idle strategy", () => {
    it("does not deliver on poke", () => {
      const onDeliver = vi.fn();
      const buffer = new DeliveryBuffer({ strategy: "on-idle", debounceMs: 0, onDeliver });

      buffer.poke();
      buffer.poke();
      expect(onDeliver).not.toHaveBeenCalled();

      buffer.destroy();
    });

    it("delivers on markIdle when there is pending content", () => {
      const onDeliver = vi.fn();
      const buffer = new DeliveryBuffer({ strategy: "on-idle", debounceMs: 0, onDeliver });

      buffer.poke();
      buffer.markIdle();
      expect(onDeliver).toHaveBeenCalledTimes(1);

      buffer.destroy();
    });

    it("does not deliver on markIdle with no pending content", () => {
      const onDeliver = vi.fn();
      const buffer = new DeliveryBuffer({ strategy: "on-idle", debounceMs: 0, onDeliver });

      buffer.markIdle();
      expect(onDeliver).not.toHaveBeenCalled();

      buffer.destroy();
    });
  });

  describe("debounced strategy", () => {
    it("delivers after debounceMs of silence", () => {
      const onDeliver = vi.fn();
      const buffer = new DeliveryBuffer({
        strategy: "debounced",
        debounceMs: 500,
        onDeliver,
      });

      buffer.poke();
      expect(onDeliver).not.toHaveBeenCalled();

      vi.advanceTimersByTime(499);
      expect(onDeliver).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onDeliver).toHaveBeenCalledTimes(1);

      buffer.destroy();
    });

    it("resets timer on subsequent pokes", () => {
      const onDeliver = vi.fn();
      const buffer = new DeliveryBuffer({
        strategy: "debounced",
        debounceMs: 500,
        onDeliver,
      });

      buffer.poke();
      vi.advanceTimersByTime(400);
      buffer.poke(); // Reset timer
      vi.advanceTimersByTime(400);
      expect(onDeliver).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(onDeliver).toHaveBeenCalledTimes(1);

      buffer.destroy();
    });

    it("flushes immediately on markIdle", () => {
      const onDeliver = vi.fn();
      const buffer = new DeliveryBuffer({
        strategy: "debounced",
        debounceMs: 500,
        onDeliver,
      });

      buffer.poke();
      buffer.markIdle();
      expect(onDeliver).toHaveBeenCalledTimes(1);

      // Timer should be cancelled — no double delivery
      vi.advanceTimersByTime(1000);
      expect(onDeliver).toHaveBeenCalledTimes(1);

      buffer.destroy();
    });
  });

  describe("flush", () => {
    it("forces immediate delivery", () => {
      const onDeliver = vi.fn();
      const buffer = new DeliveryBuffer({
        strategy: "debounced",
        debounceMs: 5000,
        onDeliver,
      });

      buffer.poke();
      buffer.flush();
      expect(onDeliver).toHaveBeenCalledTimes(1);

      buffer.destroy();
    });

    it("is a no-op with no pending content", () => {
      const onDeliver = vi.fn();
      const buffer = new DeliveryBuffer({
        strategy: "debounced",
        debounceMs: 5000,
        onDeliver,
      });

      buffer.flush();
      expect(onDeliver).not.toHaveBeenCalled();

      buffer.destroy();
    });
  });
});

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set to a known time
    vi.setSystemTime(new Date("2026-02-14T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows messages under the per-minute limit", () => {
    const limiter = new RateLimiter({ maxPerMinute: 3 });
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(false);
  });

  it("resets per-minute window after 60 seconds", () => {
    const limiter = new RateLimiter({ maxPerMinute: 1 });
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.check().allowed).toBe(true);
  });

  it("enforces daily limit", () => {
    const limiter = new RateLimiter({ maxPerMinute: 100, maxPerDay: 2 });
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(false);
  });

  it("resets daily limit at midnight", () => {
    const limiter = new RateLimiter({ maxPerDay: 1 });
    expect(limiter.check().allowed).toBe(true);
    expect(limiter.check().allowed).toBe(false);

    // Advance to next day
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(limiter.check().allowed).toBe(true);
  });

  it("calls onLimited with remaining and resetMs", () => {
    const onLimited = vi.fn(() => "Slow down!");
    const limiter = new RateLimiter({ maxPerMinute: 1, onLimited });

    limiter.check(); // allowed
    const result = limiter.check(); // limited

    expect(result.allowed).toBe(false);
    expect(result).toEqual({ allowed: false, reply: "Slow down!" });
    expect(onLimited).toHaveBeenCalledWith(expect.objectContaining({ remaining: 0 }));
  });

  it("returns no reply when onLimited returns void", () => {
    const onLimited = vi.fn();
    const limiter = new RateLimiter({ maxPerMinute: 1, onLimited });

    limiter.check();
    const result = limiter.check();

    expect(result).toEqual({ allowed: false, reply: undefined });
  });
});
