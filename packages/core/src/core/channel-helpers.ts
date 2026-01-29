import { Channel, type ChannelEvent } from "./channel";
import { Context } from "./context";

/**
 * Helper functions for accessing channels from KernelContext.
 * These provide convenient access patterns for tools and components.
 */

/**
 * Get a channel from the current context.
 * @throws Error if channels are not available in context
 */
export function getChannel(channelName: string): Channel {
  const ctx = Context.get();
  if (!ctx.channels) {
    throw new Error(
      "Channels are not available in the current context. Ensure channels are configured in EngineConfig.",
    );
  }
  return ctx.channels.getChannel(ctx, channelName);
}

/**
 * Publish an event to a channel using the current context.
 * @throws Error if channels are not available in context
 */
export function publishChannel(channelName: string, event: Omit<ChannelEvent, "channel">): void {
  const ctx = Context.get();
  if (!ctx.channels) {
    throw new Error(
      "Channels are not available in the current context. Ensure channels are configured in EngineConfig.",
    );
  }
  ctx.channels.publish(ctx, channelName, event);
}

/**
 * Subscribe to events on a channel using the current context.
 * @returns Unsubscribe function
 * @throws Error if channels are not available in context
 */
export function subscribeChannel(
  channelName: string,
  handler: (event: ChannelEvent) => void,
): () => void {
  const ctx = Context.get();
  if (!ctx.channels) {
    throw new Error(
      "Channels are not available in the current context. Ensure channels are configured in EngineConfig.",
    );
  }
  return ctx.channels.subscribe(ctx, channelName, handler);
}

/**
 * Wait for a response on a channel using the current context.
 * @throws Error if channels are not available in context
 */
export function waitForChannelResponse(
  channelName: string,
  requestId: string,
  timeoutMs?: number,
): Promise<ChannelEvent> {
  const ctx = Context.get();
  if (!ctx.channels) {
    throw new Error(
      "Channels are not available in the current context. Ensure channels are configured in EngineConfig.",
    );
  }
  return ctx.channels.waitForResponse(ctx, channelName, requestId, timeoutMs);
}

/**
 * Try to get a channel from the current context (returns undefined if not available).
 */
export function tryGetChannel(channelName: string): Channel | undefined {
  const ctx = Context.tryGet();
  if (!ctx?.channels) {
    return undefined;
  }
  return ctx.channels.getChannel(ctx, channelName);
}
