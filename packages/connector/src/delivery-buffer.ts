import type { DeliveryStrategy, RateLimitConfig } from "./types.js";

// ============================================================================
// Delivery Buffer
// ============================================================================

export interface DeliveryBufferOptions {
  strategy: DeliveryStrategy;
  debounceMs: number;
  onDeliver: () => void;
}

/**
 * Controls when outbound messages are delivered to the platform.
 *
 * - `"immediate"` — calls onDeliver on every poke
 * - `"on-idle"` — calls onDeliver only when markIdle() is called
 * - `"debounced"` — calls onDeliver after debounceMs of no pokes
 */
export class DeliveryBuffer {
  private readonly _strategy: DeliveryStrategy;
  private readonly _debounceMs: number;
  private readonly _onDeliver: () => void;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _hasPending = false;

  constructor(options: DeliveryBufferOptions) {
    this._strategy = options.strategy;
    this._debounceMs = options.debounceMs;
    this._onDeliver = options.onDeliver;
  }

  /**
   * Signal that new content is available.
   */
  poke(): void {
    this._hasPending = true;

    switch (this._strategy) {
      case "immediate":
        this._deliver();
        break;
      case "on-idle":
        // Wait for markIdle()
        break;
      case "debounced":
        this._resetTimer();
        break;
    }
  }

  /**
   * Signal that execution is complete (idle).
   * For "on-idle" strategy, this triggers delivery.
   * For "debounced", this flushes immediately if anything is pending.
   */
  markIdle(): void {
    if (this._hasPending) {
      this._clearTimer();
      this._deliver();
    }
  }

  /**
   * Force immediate delivery of any pending content.
   */
  flush(): void {
    if (this._hasPending) {
      this._clearTimer();
      this._deliver();
    }
  }

  destroy(): void {
    this._clearTimer();
  }

  private _deliver(): void {
    this._hasPending = false;
    this._onDeliver();
  }

  private _resetTimer(): void {
    this._clearTimer();
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._hasPending) this._deliver();
    }, this._debounceMs);
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

// ============================================================================
// Rate Limiter
// ============================================================================

/**
 * Sliding-window rate limiter for inbound messages.
 * Tracks per-minute and per-day counts.
 */
export class RateLimiter {
  private readonly _maxPerMinute: number;
  private readonly _maxPerDay: number;
  private readonly _onLimited?: RateLimitConfig["onLimited"];
  private _minuteTimestamps: number[] = [];
  private _dayCount = 0;
  private _dayStart = 0;

  constructor(config: RateLimitConfig) {
    this._maxPerMinute = config.maxPerMinute ?? Infinity;
    this._maxPerDay = config.maxPerDay ?? Infinity;
    this._onLimited = config.onLimited;
    this._dayStart = startOfDay(Date.now());
  }

  /**
   * Check if a message should be allowed through.
   * Returns `{ allowed: true }` or `{ allowed: false, reply?: string }`.
   */
  check(): { allowed: true } | { allowed: false; reply?: string } {
    const now = Date.now();

    // Reset daily counter if we're in a new day
    const today = startOfDay(now);
    if (today !== this._dayStart) {
      this._dayStart = today;
      this._dayCount = 0;
    }

    // Prune minute window
    const oneMinuteAgo = now - 60_000;
    this._minuteTimestamps = this._minuteTimestamps.filter((t) => t > oneMinuteAgo);

    // Check daily limit
    if (this._dayCount >= this._maxPerDay) {
      const resetMs = this._dayStart + 86_400_000 - now;
      const reply = this._onLimited?.({ remaining: 0, resetMs });
      return { allowed: false, reply: reply ?? undefined };
    }

    // Check per-minute limit
    if (this._minuteTimestamps.length >= this._maxPerMinute) {
      const oldestInWindow = this._minuteTimestamps[0]!;
      const resetMs = oldestInWindow + 60_000 - now;
      const remaining = 0;
      const reply = this._onLimited?.({ remaining, resetMs });
      return { allowed: false, reply: reply ?? undefined };
    }

    // Allow
    this._minuteTimestamps.push(now);
    this._dayCount++;
    return { allowed: true };
  }
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
