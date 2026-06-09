/**
 * In-process scheduler driver — fires `cron` subscription intents
 * via `setTimeout` chains.
 *
 * Watches `bridge.list()`. For every intent with `kind === "cron"`,
 * computes the next-fire-time from `config.expr` (a 5-field cron
 * expression OR one of the `@hourly`/`@daily`/`@weekly`/`@monthly`
 * macros) and schedules `bridge.dispatch(id, …)` to run at that time.
 * After firing, reschedules.
 *
 * Re-evaluates the intent list on every `bridge.subscribe` callback
 * — adding or removing `<Cron>` JSX is picked up live.
 *
 * Limitations / non-goals:
 *   - Single-process. Two app instances each get their own scheduler
 *     and will fire the same intent twice. For multi-instance
 *     deployments, use an external scheduler (k8s CronJob, BullMQ,
 *     etc.) and disable this driver via `withSubscriptions({ scheduler: false })`.
 *   - Drift tolerance is whatever `setTimeout` gives — a few ms in
 *     practice, more under heavy load. Fine for hourly/daily; bad
 *     for sub-second.
 *   - No catch-up after a missed window — if the process is suspended
 *     past a scheduled fire time, that occurrence is dropped. Adopters
 *     who need catch-up persist intent state externally.
 */

import type { SubscriptionIntent, Unsubscribe } from "@agentick/spec-next";

import type { SubscriptionBridge } from "./bridge.js";

interface CronEntry {
  readonly intentId: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function attachInProcessScheduler(bridge: SubscriptionBridge): Unsubscribe {
  const timers = new Map<string, CronEntry>();
  let closed = false;

  const scheduleNext = (intent: SubscriptionIntent): void => {
    if (closed) return;
    const delay = nextDelayMs(intent);
    if (delay === null) return;
    const existing = timers.get(intent.id);
    if (existing?.timer) clearTimeout(existing.timer);
    const entry: CronEntry = { intentId: intent.id, timer: undefined };
    timers.set(intent.id, entry);
    entry.timer = setTimeout(() => {
      if (closed) return;
      // Best-effort: swallow errors so a single bad handler can't
      // tear down the scheduler.
      bridge
        .dispatch(intent.id, { firedAt: Date.now() })
        .catch(() => {
          // best effort
        })
        .finally(() => {
          if (closed) return;
          // Reschedule against the current intent (it may have been
          // re-declared with a different expression mid-run).
          const fresh = bridge.list().find((i) => i.id === intent.id);
          if (fresh && fresh.kind === "cron") scheduleNext(fresh);
        });
    }, delay);
  };

  const sync = (): void => {
    if (closed) return;
    const intents = bridge.list();
    const currentIds = new Set(intents.map((i) => i.id));
    // Cancel timers for removed / non-cron intents.
    for (const [id, entry] of timers) {
      const fresh = intents.find((i) => i.id === id);
      if (!fresh || fresh.kind !== "cron") {
        if (entry.timer) clearTimeout(entry.timer);
        timers.delete(id);
      }
    }
    // Schedule timers for new cron intents.
    for (const intent of intents) {
      if (intent.kind !== "cron") continue;
      if (timers.has(intent.id)) continue;
      scheduleNext(intent);
    }
    void currentIds;
  };

  // Initial pass + subscribe for live changes.
  sync();
  const unsub = bridge.subscribe(sync);

  return () => {
    closed = true;
    unsub();
    for (const entry of timers.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    timers.clear();
  };
}

// ============================================================================
// Cron evaluation
// ============================================================================

/**
 * Returns the delay in ms until the next firing of `intent`, or
 * `null` when the expression is unparseable.
 *
 * Supports:
 *   - Macros: `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`
 *   - 5-field cron: `min hour dom month dow`, with `*`, `*\/N`, single
 *     numbers, and comma lists. No ranges, no day-of-week names.
 *
 * Adopters who need a richer parser supply their own scheduler driver
 * — turn off the default with `withSubscriptions({ scheduler: false })`
 * and call `bridge.dispatch(id, ...)` from your scheduler.
 */
function nextDelayMs(intent: SubscriptionIntent): number | null {
  const expr = String((intent.config as { expr?: unknown }).expr ?? "");
  if (expr.length === 0) return null;
  const next = nextCronTime(expr, new Date());
  if (next === null) return null;
  const delay = next.getTime() - Date.now();
  return Math.max(delay, 0);
}

function nextCronTime(expr: string, from: Date): Date | null {
  const macro = MACROS[expr];
  const fields = macro ?? parseFields(expr);
  if (!fields) return null;
  const [minutes, hours, doms, months, dows] = fields;

  // Step minute-by-minute from `from + 1 minute` until all fields match.
  // Capped to one year of lookahead to avoid infinite loops on bad
  // input (e.g., DOM/DOW combinations that never fire).
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const cap = new Date(start.getTime() + 366 * 24 * 60 * 60 * 1000);
  let cursor = start;
  while (cursor < cap) {
    if (
      minutes.has(cursor.getMinutes()) &&
      hours.has(cursor.getHours()) &&
      months.has(cursor.getMonth() + 1) &&
      (doms.has(cursor.getDate()) || dows.has(cursor.getDay()))
    ) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return null;
}

const MACROS: Readonly<Record<string, readonly Set<number>[] | undefined>> = {
  "@hourly": [setOf(0), allHours(), allDom(), allMonths(), allDow()],
  "@daily": [setOf(0), setOf(0), allDom(), allMonths(), allDow()],
  "@weekly": [setOf(0), setOf(0), allDom(), allMonths(), setOf(0)],
  "@monthly": [setOf(0), setOf(0), setOf(1), allMonths(), allDow()],
  "@yearly": [setOf(0), setOf(0), setOf(1), setOf(1), allDow()],
};

function parseFields(expr: string): readonly Set<number>[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  const minute = parseField(m!, 0, 59);
  const hour = parseField(h!, 0, 23);
  const day = parseField(dom!, 1, 31);
  const month = parseField(mon!, 1, 12);
  const week = parseField(dow!, 0, 6);
  if (!minute || !hour || !day || !month || !week) return null;
  return [minute, hour, day, month, week];
}

function parseField(field: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = lo; i <= hi; i++) out.add(i);
      continue;
    }
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!Number.isFinite(step) || step <= 0) return null;
      for (let i = lo; i <= hi; i += step) out.add(i);
      continue;
    }
    const n = Number(part);
    if (!Number.isFinite(n) || n < lo || n > hi) return null;
    out.add(n);
  }
  return out.size > 0 ? out : null;
}

function setOf(...vals: number[]): Set<number> {
  return new Set(vals);
}

function allHours(): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < 24; i++) s.add(i);
  return s;
}

function allDom(): Set<number> {
  const s = new Set<number>();
  for (let i = 1; i <= 31; i++) s.add(i);
  return s;
}

function allMonths(): Set<number> {
  const s = new Set<number>();
  for (let i = 1; i <= 12; i++) s.add(i);
  return s;
}

function allDow(): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < 7; i++) s.add(i);
  return s;
}
