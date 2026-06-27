/**
 * Tiny props-reader helpers. React props are typed `unknown` at the
 * walker's boundary; these guards return the value if it matches the
 * expected shape, undefined otherwise. Stops the dispatcher from being
 * a wall of `typeof props.x === "string" ? props.x : undefined`
 * patterns.
 *
 * Use these for any prop you'd pass to a compiler-next helper —
 * narrow at the boundary, hand the narrowed value to the helper.
 */

import type { MediaSource } from "@agentick/spec-next";

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function asStringRecord(v: unknown): Record<string, string> | undefined {
  const rec = asRecord(v);
  if (!rec) return undefined;
  for (const k in rec) {
    if (typeof rec[k] !== "string") return undefined;
  }
  return rec as Record<string, string>;
}

export function asStringArray(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  for (const item of v) {
    if (typeof item !== "string") return undefined;
  }
  return v as readonly string[];
}

/**
 * Validates `v` is a plausible MediaSource: an object with a
 * discriminant `type` string in the known set. Doesn't deeply
 * validate each variant's payload — the caller is expected to pass
 * adopter-supplied values, and the helper's role is "is this even
 * shaped like a MediaSource at all."
 *
 * Returns the value cast to MediaSource if plausible; undefined
 * otherwise.
 */
export function asMediaSource(v: unknown): MediaSource | undefined {
  const rec = asRecord(v);
  if (!rec) return undefined;
  const t = asString(rec.type);
  if (t !== "url" && t !== "base64" && t !== "reference" && t !== "s3" && t !== "gcs") {
    return undefined;
  }
  return rec as unknown as MediaSource;
}

/**
 * Narrowed reader for the audience prop on `<section>`. Returns the
 * literal value if it matches the known set; undefined otherwise.
 */
export function asAudience(v: unknown): "model" | "user" | "both" | undefined {
  return v === "model" || v === "user" || v === "both" ? v : undefined;
}
