/**
 * How adapter options and the environment reconcile into `GoogleGenAI`'s
 * constructor options.
 *
 * One rule carries the whole file: **a fallback must never be able to invalidate an
 * explicit choice.** `GoogleGenAI` treats `project`/`location` and `apiKey` as
 * mutually exclusive and throws when given both, so an env-derived `apiKey` merged
 * onto an adopter's explicit Vertex configuration does not merely lose a race — it
 * produces a client that cannot be constructed.
 *
 * Observed live: an adopter passed `{ vertexai: true, project, location }`, had
 * `GOOGLE_API_KEY` in the environment for unrelated reasons, and every execution
 * died in single-digit milliseconds with
 *
 *   Project/location and API key are mutually exclusive in the client initializer.
 *
 * The adopter had configured Vertex correctly. The framework added the field that
 * broke it.
 */

import { afterEach, describe, expect, it } from "vitest";

import { buildClientOptions } from "../google-adapter.js";

const KEYS = ["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENAI_BASE_URL"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const key of KEYS) {
    if (saved.has(key)) {
      const original = saved.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
  saved.clear();
});

describe("buildClientOptions — the env API key is a fallback, not an override", () => {
  it("fills in apiKey from the environment when nothing else selects a transport", () => {
    setEnv("GOOGLE_API_KEY", "env-key");
    expect(buildClientOptions({}).apiKey).toBe("env-key");
  });

  it("accepts GEMINI_API_KEY as the alternate name", () => {
    setEnv("GOOGLE_API_KEY", undefined);
    setEnv("GEMINI_API_KEY", "gemini-key");
    expect(buildClientOptions({}).apiKey).toBe("gemini-key");
  });

  it("an explicit apiKey wins over the environment's", () => {
    setEnv("GOOGLE_API_KEY", "env-key");
    expect(buildClientOptions({ clientOptions: { apiKey: "explicit" } }).apiKey).toBe("explicit");
  });

  it("VERTEX suppresses the env key entirely — the regression", () => {
    // Not "the adopter's value wins": there is no adopter value to win. The env key
    // must not be added AT ALL, because its mere presence alongside project/location
    // makes the client unconstructable.
    setEnv("GOOGLE_API_KEY", "env-key");
    const resolved = buildClientOptions({
      clientOptions: { vertexai: true, project: "p-1", location: "us-central1" },
    });
    expect("apiKey" in resolved).toBe(false);
    expect(resolved.project).toBe("p-1");
    expect(resolved.location).toBe("us-central1");
    expect(resolved.vertexai).toBe(true);
  });

  it("a bare `project` is enough to mean Vertex — `vertexai: true` is not required", () => {
    // The SDK's exclusivity is about project/location, not about the flag, so the
    // suppression has to key on the same thing the SDK does.
    setEnv("GOOGLE_API_KEY", "env-key");
    expect("apiKey" in buildClientOptions({ clientOptions: { project: "p-1" } })).toBe(false);
    expect("apiKey" in buildClientOptions({ clientOptions: { location: "us-central1" } })).toBe(
      false,
    );
  });

  it("does NOT arbitrate between two EXPLICIT instructions", () => {
    // An adopter who passes both an apiKey and Vertex fields gets the SDK's own
    // error, and should: inventing a precedence between two things they asked for
    // silently discards one of them, which is how this bug class starts.
    setEnv("GOOGLE_API_KEY", undefined);
    setEnv("GEMINI_API_KEY", undefined);
    const resolved = buildClientOptions({
      clientOptions: { apiKey: "explicit", project: "p-1" },
    });
    expect(resolved.apiKey).toBe("explicit");
    expect(resolved.project).toBe("p-1");
  });

  it("the baseUrl fallback still applies on the Vertex path", () => {
    // Only the API key conflicts. Suppressing every env fallback under Vertex would
    // be over-correcting.
    setEnv("GOOGLE_API_KEY", "env-key");
    setEnv("GOOGLE_GENAI_BASE_URL", "https://proxy.internal");
    const resolved = buildClientOptions({ clientOptions: { project: "p-1" } });
    expect(resolved.httpOptions?.baseUrl).toBe("https://proxy.internal");
    expect("apiKey" in resolved).toBe(false);
  });

  it("merges httpOptions deeply — env baseUrl plus adopter timeout", () => {
    setEnv("GOOGLE_GENAI_BASE_URL", "https://proxy.internal");
    const resolved = buildClientOptions({
      clientOptions: { apiKey: "k", httpOptions: { timeout: 5000 } },
    });
    expect(resolved.httpOptions).toEqual({ baseUrl: "https://proxy.internal", timeout: 5000 });
  });
});
