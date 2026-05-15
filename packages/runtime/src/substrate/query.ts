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
