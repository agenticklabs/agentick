/**
 * Module augmentation — the modality executors reach tool handlers as
 * `ctx.images` / `ctx.embeddings` (ADR 105 §4), through the ADR 66 seam for
 * optional harnesses not every deployment mounts (the `sandbox` precedent).
 * The app folds the executors into `ctxExtensions`; this types the slots.
 */

import type { EmbeddingModelExecutorProtocol, ImageModelExecutorProtocol } from "@agentick/spec";

declare module "@agentick/spec" {
  interface ToolHandlerCtxExtensions {
    readonly images?: ImageModelExecutorProtocol;
    readonly embeddings?: EmbeddingModelExecutorProtocol;
  }
}
