/**
 * A `google()` adapter wired into a real `LanguageModelExecutor` over the stub
 * client from `../testing/index.js`.
 *
 * Lives in `__tests__` rather than beside the stub because it pulls
 * `@agentick/model-executor` and `@agentick/runtime` — devDependencies here, so
 * they must not reach the published `/testing` surface.
 */

import { omitUndefined } from "@agentick/utils";

import type { ExecutionTarget, ProviderOptions, RenderedTree } from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { LanguageModelExecutor } from "@agentick/model-executor";

import { google } from "../google-adapter.js";
import { StubGoogleClient, asClient } from "../testing/index.js";

/** A one-user-message tree — the minimum a target will accept. */
export function emptyTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m_1", role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
  };
}

export async function makeExecutor(
  stub: StubGoogleClient,
  opts: {
    stream?: boolean;
    model?: string;
    parseThinkTags?: boolean;
    customBlocks?: Record<string, { tag?: string; onContent?: (c: string) => void }>;
    providerOptions?: ProviderOptions;
    target?: ExecutionTarget;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new LanguageModelExecutor("exec-google-test", journal, bus, inbox, {
    adapter: google(opts.model ?? "gemini-2.5-flash", {
      client: asClient(stub),
      ...omitUndefined({
        stream: opts.stream,
        providerOptions: opts.providerOptions,
        target: opts.target,
      }),
      ...(opts.parseThinkTags ? { parseThinkTags: true } : {}),
      ...(opts.customBlocks ? { customBlocks: opts.customBlocks } : {}),
    }),
  });
  await exec.ready;
  return { exec, journal, bus, inbox };
}
