/**
 * EventQuery matcher.
 *
 * Pure-function predicate over a ProtocolEvent given a query. Used by
 * journal reads, bus subscribers, and conformance fixtures.
 *
 * Match semantics:
 *   - surface:    string OR string[] (any-of)
 *   - phase:      string OR string[] (any-of)
 *   - outcome:    string OR string[] (any-of)
 *   - name:       discriminated NameQuery (exact | prefix | segments | wildcard)
 *   - tagsAny:    any of the provided tags appears on the event
 *   - scope:      every present key in the query MUST match the event's scope
 *
 * Unknown fields are ignored (forward-compat).
 */

import type {
  EventQuery,
  EventSurface,
  EventPhase,
  ProtocolEvent,
  NameQuery,
} from "@agentick/spec";
import type { CommandOutcome } from "@agentick/spec";

function asArray<T>(v: T | readonly T[] | undefined): readonly T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? (v as readonly T[]) : ([v] as readonly T[]);
}

function nameMatches(name: string, query: NameQuery): boolean {
  if ("exact" in query) return name === query.exact;
  if ("prefix" in query) return name.startsWith(query.prefix);
  if ("segments" in query) {
    const parts = name.split(":");
    if (query.segments.length > parts.length) return false;
    for (let i = 0; i < query.segments.length; i++) {
      if (query.segments[i] !== parts[i]) return false;
    }
    return true;
  }
  if ("wildcard" in query) {
    // Wildcard segments: "*" matches a single segment, "**" matches the rest.
    const pat = query.wildcard.split(":");
    const parts = name.split(":");
    let pi = 0;
    let ni = 0;
    while (pi < pat.length && ni < parts.length) {
      const seg = pat[pi]!;
      if (seg === "**") return true; // match remainder
      if (seg !== "*" && seg !== parts[ni]) return false;
      pi++;
      ni++;
    }
    return pi === pat.length && ni === parts.length;
  }
  return false;
}

export function matchesQuery(event: ProtocolEvent, query: EventQuery): boolean {
  const surfaces = asArray<EventSurface>(query.surface);
  if (surfaces && !surfaces.includes(event.surface)) return false;

  if (query.name && !nameMatches(event.name, query.name)) return false;

  const phases = asArray<EventPhase>(query.phase);
  if (phases && !phases.includes(event.phase)) return false;

  const outcomes = asArray<CommandOutcome>(query.outcome);
  if (outcomes) {
    const o = event.outcome;
    if (!o || !outcomes.includes(o)) return false;
  }

  if (query.tagsAny && query.tagsAny.length > 0) {
    const tags = event.tags ?? [];
    let hit = false;
    for (const t of query.tagsAny) {
      if (tags.includes(t)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }

  if (query.scope) {
    const evScope = event.scope ?? {};
    for (const [k, v] of Object.entries(query.scope)) {
      if (v === undefined) continue;
      if ((evScope as Record<string, unknown>)[k] !== v) return false;
    }
  }

  return true;
}

// ============================================================================
// compileQuery — specialise at subscribe time
// ============================================================================

/**
 * Pre-compiled query matcher. Cheap to invoke (~tens of ns for typical
 * `{ surface, phase }` shapes) because it captures only the fields the
 * query actually constrains. Built once at subscribe time via
 * {@link compileQuery}; invoked on every published event.
 */
export type CompiledMatcher = (event: ProtocolEvent) => boolean;

/**
 * Specialise an {@link EventQuery} to a tight predicate closure.
 *
 * Walks the query once at subscribe time, collects only the field
 * checks the query actually carries, then composes them into a single
 * closure. The hot path (per-event filter on the publish loop) trades
 * a polymorphic walk of the EventQuery union for a fixed sequence of
 * inlined field comparisons.
 *
 * Empty query → matches every event.
 *
 * Specialisations:
 *  - `surface` scalar → `e.surface === s`
 *  - `surface` array → `set.has(e.surface)`
 *  - `phase` scalar / array → same
 *  - `name: { exact }` → `e.name === exact`
 *  - `name: { prefix }` → `e.name.startsWith(prefix)`
 *  - `name: { segments }` → segment-by-segment compare
 *  - `name: { wildcard }` → pre-split pattern
 *  - `outcome`, `tagsAny`, `scope` — pre-snapshot the relevant data
 */
export function compileQuery(query: EventQuery): CompiledMatcher {
  const checks: Array<CompiledMatcher> = [];

  // surface
  if (query.surface !== undefined) {
    if (Array.isArray(query.surface)) {
      const set = new Set<string>(query.surface);
      checks.push((e) => set.has(e.surface));
    } else {
      const surface = query.surface;
      checks.push((e) => e.surface === surface);
    }
  }

  // phase
  if (query.phase !== undefined) {
    if (Array.isArray(query.phase)) {
      const set = new Set<string>(query.phase);
      checks.push((e) => set.has(e.phase));
    } else {
      const phase = query.phase;
      checks.push((e) => e.phase === phase);
    }
  }

  // name (discriminated union)
  if (query.name !== undefined) {
    const n = query.name;
    if ("exact" in n) {
      const exact = n.exact;
      checks.push((e) => e.name === exact);
    } else if ("prefix" in n) {
      const prefix = n.prefix;
      checks.push((e) => e.name.startsWith(prefix));
    } else if ("segments" in n) {
      const segments = n.segments;
      const len = segments.length;
      checks.push((e) => {
        const parts = e.name.split(":");
        if (len > parts.length) return false;
        for (let i = 0; i < len; i++) {
          if (segments[i] !== parts[i]) return false;
        }
        return true;
      });
    } else if ("wildcard" in n) {
      const pat = n.wildcard.split(":");
      const patLen = pat.length;
      checks.push((e) => {
        const parts = e.name.split(":");
        let pi = 0;
        let ni = 0;
        while (pi < patLen && ni < parts.length) {
          const seg = pat[pi]!;
          if (seg === "**") return true;
          if (seg !== "*" && seg !== parts[ni]) return false;
          pi++;
          ni++;
        }
        return pi === patLen && ni === parts.length;
      });
    }
  }

  // outcome
  if (query.outcome !== undefined) {
    if (Array.isArray(query.outcome)) {
      const set = new Set<string>(query.outcome);
      checks.push((e) => {
        const o = e.outcome;
        return o !== undefined && set.has(o);
      });
    } else {
      const outcome = query.outcome;
      checks.push((e) => e.outcome === outcome);
    }
  }

  // tagsAny
  if (query.tagsAny !== undefined && query.tagsAny.length > 0) {
    const set = new Set<string>(query.tagsAny);
    checks.push((e) => {
      const tags = e.tags;
      if (!tags || tags.length === 0) return false;
      for (let i = 0; i < tags.length; i++) {
        if (set.has(tags[i]!)) return true;
      }
      return false;
    });
  }

  // scope — pre-snapshot the present keys so we don't re-enter
  // Object.entries on every event.
  if (query.scope !== undefined) {
    const entries: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(query.scope)) {
      if (v !== undefined) entries.push([k, v]);
    }
    if (entries.length > 0) {
      checks.push((e) => {
        const evScope = e.scope as Record<string, unknown> | undefined;
        if (!evScope) return false;
        for (let i = 0; i < entries.length; i++) {
          const [k, v] = entries[i]!;
          if (evScope[k] !== v) return false;
        }
        return true;
      });
    }
  }

  if (checks.length === 0) return () => true;
  if (checks.length === 1) return checks[0]!;
  if (checks.length === 2) {
    const a = checks[0]!;
    const b = checks[1]!;
    return (e) => a(e) && b(e);
  }
  // Generic AND for 3+ predicates.
  const fns = checks;
  const n = fns.length;
  return (event) => {
    for (let i = 0; i < n; i++) {
      if (!fns[i]!(event)) return false;
    }
    return true;
  };
}
