/**
 * `sourceFromUrl` — fetch a URL once at `load()` time and let the caller
 * deserialize the response.
 *
 * The parse callback receives the raw `Response` (no implicit `.json()`
 * or `.text()`) so callers can choose: JSON manifest, plain text body,
 * binary blob, etc. The callback MUST return a `readonly T[]` — if the
 * URL serves a single record, wrap it in a one-element array.
 *
 * **Constraint:** records loaded from URLs cannot carry functions
 * (handlers, render callbacks, hooks). Any harness whose record type
 * includes code MUST either reject `sourceFromUrl` or constrain the
 * record-type to its function-free subset before exposing it.
 *
 * Throws on non-OK responses by default — pass `acceptStatuses` to
 * widen the success set (e.g., `[200, 304]` if the upstream returns
 * 304 with a cached-payload body).
 */

import type { Loader } from "./loader.js";

export interface FromUrlOptions<T> {
  readonly url: string | URL;
  readonly parse: (response: Response) => Promise<readonly T[]>;
  readonly fetch?: typeof fetch;
  readonly init?: RequestInit;
  readonly acceptStatuses?: readonly number[];
}

export function sourceFromUrl<T>(options: FromUrlOptions<T>): Loader<T> {
  const accept = options.acceptStatuses;
  return {
    load: async () => {
      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (typeof fetchImpl !== "function") {
        throw new Error("sourceFromUrl: no global `fetch` available; pass `fetch` in options");
      }
      const response = await fetchImpl(options.url, options.init);
      const ok = accept ? accept.includes(response.status) : response.ok;
      if (!ok) {
        throw new Error(
          `sourceFromUrl: ${String(options.url)} returned HTTP ${response.status} ${response.statusText}`,
        );
      }
      return options.parse(response);
    },
  };
}
