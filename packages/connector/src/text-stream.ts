/**
 * Project a turn's `StreamEvent`s onto plain assistant text: live
 * `content-delta` chunks while a text block streams, whole text blocks from
 * `content` summary events when the provider doesn't stream. One projection,
 * both provider modes — a consumer just pipes strings.
 */

import type { StreamEvent } from "@agentick/spec";

export function textStream(events: ReadableStream<StreamEvent>): ReadableStream<string> {
  const textBlocks = new Set<number>();
  // Blocks whose text already went out — as deltas, or as a whole `content`
  // block. The stream can carry the same text twice (a `content` summary after
  // its deltas, or per-tick re-emission); each block's text goes out ONCE.
  const emitted = new Set<number>();
  return events.pipeThrough(
    new TransformStream<StreamEvent, string>({
      transform(event, controller) {
        switch (event.type) {
          case "content-start":
            if (event.blockType === "text") textBlocks.add(event.blockIndex);
            break;
          case "content-delta":
            if (textBlocks.has(event.blockIndex)) {
              emitted.add(event.blockIndex);
              controller.enqueue(event.delta);
            }
            break;
          case "content":
            if (
              event.content.type === "text" &&
              typeof event.content.text === "string" &&
              !emitted.has(event.blockIndex)
            ) {
              emitted.add(event.blockIndex);
              controller.enqueue(event.content.text);
            }
            break;
          default:
            break;
        }
      },
    }),
  );
}
