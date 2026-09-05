/** A `fetch` that answers every call with the same canned body, recording what it was asked. */

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal | undefined;
}

export interface StubFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly calls: RecordedRequest[];
}

export function stubFetch(
  chunks: readonly string[] | string,
  init: { status?: number } = {},
): StubFetch {
  const pieces = typeof chunks === "string" ? [chunks] : chunks;
  const calls: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, reqInit?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (reqInit?.headers ?? {}) as Record<string, string>,
      body: typeof reqInit?.body === "string" ? JSON.parse(reqInit.body) : reqInit?.body,
      signal: reqInit?.signal ?? undefined,
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    });
    return new Response(stream, {
      status: init.status ?? 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  };
  return Object.assign(impl, { calls });
}

export function throwingFetch(cause: unknown): typeof fetch {
  return async () => {
    throw cause;
  };
}

export function statsTrailer(stats: Record<string, unknown>): string {
  return `<|stats|>${JSON.stringify(stats)}<|/stats|>`;
}
