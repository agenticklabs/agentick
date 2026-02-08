/**
 * SSE (Server-Sent Events) utilities.
 *
 * Provides helpers for streaming events to clients via SSE.
 * Works with any web framework that supports writable streams.
 *
 * @module @agentick/server/sse
 */

import type { SSEWriter, SSEWriterOptions } from "./types";

/**
 * Create an SSE writer for a response stream.
 *
 * Works with any writable stream that has write() and end() methods
 * (Node.js response, Express response, etc.).
 *
 * @example
 * ```typescript
 * // Express
 * app.get('/events', (req, res) => {
 *   setSSEHeaders(res);
 *   const writer = createSSEWriter(res);
 *
 *   // Write events
 *   writer.writeEvent({
 *     channel: 'session:events',
 *     type: 'content_delta',
 *     payload: { delta: 'Hello' },
 *   });
 *
 *   // Close when done
 *   writer.close();
 * });
 * ```
 */
export function createSSEWriter(
  stream: { write: (data: string) => void; end: () => void },
  options: SSEWriterOptions = {},
): SSEWriter {
  const keepaliveInterval = options.keepaliveInterval ?? 15000;
  const eventName = options.eventName ?? "message";

  let closed = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  // Start keepalive
  if (keepaliveInterval > 0) {
    keepaliveTimer = setInterval(() => {
      if (!closed) {
        stream.write(": keepalive\n\n");
      }
    }, keepaliveInterval);
  }

  return {
    writeEvent(event: unknown): void {
      if (closed) return;

      let data: string;
      try {
        data = JSON.stringify(event);
      } catch (err) {
        // JSON.stringify can throw on circular references, BigInt, etc.
        // Fall back to a serializable error event
        console.error("SSE: Failed to serialize event", err, event);
        data = JSON.stringify({
          type: "error",
          code: "SERIALIZATION_ERROR",
          message: `Failed to serialize event: ${(err as Error).message}`,
        });
      }
      stream.write(`event: ${eventName}\n`);
      stream.write(`data: ${data}\n\n`);
    },

    writeComment(comment: string): void {
      if (closed) return;
      stream.write(`: ${comment}\n\n`);
    },

    close(): void {
      if (closed) return;
      closed = true;

      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
      }

      stream.end();
    },

    get closed(): boolean {
      return closed;
    },
  };
}

/**
 * Stream an async iterable to SSE.
 *
 * @example
 * ```typescript
 * app.get('/sessions/:id/stream', async (req, res) => {
 *   setSSEHeaders(res);
 *
 *   const stream = sessionHandler.stream(req.params.id, {});
 *   await streamToSSE(res, stream, 'session:events');
 * });
 * ```
 */
export async function streamToSSE<T>(
  stream: { write: (data: string) => void; end: () => void },
  events: AsyncIterable<T>,
  channel: string,
  options: SSEWriterOptions = {},
): Promise<void> {
  const writer = createSSEWriter(stream, options);

  try {
    for await (const event of events) {
      writer.writeEvent({
        channel,
        type: (event as { type?: string }).type ?? "event",
        payload: event,
      });
    }
  } finally {
    writer.close();
  }
}

/**
 * Set SSE headers on a response.
 *
 * @example
 * ```typescript
 * app.get('/events', (req, res) => {
 *   setSSEHeaders(res);
 *   // ... write events
 * });
 * ```
 */
export function setSSEHeaders(res: {
  setHeader: (name: string, value: string) => void;
  flushHeaders?: () => void;
}): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

  // Flush headers immediately so EventSource 'open' event fires
  // Without this, Node.js/Express may buffer and delay the response
  if (res.flushHeaders) {
    res.flushHeaders();
  }
}
