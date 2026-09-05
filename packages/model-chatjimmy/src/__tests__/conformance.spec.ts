import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runExecutorConformance } from "@agentick/spec-conformance";
import type { LanguageModelExecutionResult } from "@agentick/spec";
import { LanguageModelExecutor } from "@agentick/model-executor";

import { chatjimmy, ChatJimmyHttpError } from "../chatjimmy-adapter.js";
import { statsTrailer, stubFetch, throwingFetch } from "./stub-fetch.js";

function bodyFor(scripted: LanguageModelExecutionResult | undefined): string {
  const text =
    scripted?.output
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "hi";
  return (
    text +
    statsTrailer({
      done: true,
      done_reason: scripted?.stopReason === "max_tokens" ? "length" : "stop",
      prefill_tokens: scripted?.usage?.inputTokens ?? 0,
      decode_tokens: scripted?.usage?.outputTokens ?? 0,
      total_tokens: scripted?.usage?.totalTokens ?? 0,
    })
  );
}

describe("chatjimmy() adapter — ExecutorProtocol conformance", () => {
  runExecutorConformance(
    async ({ harnessId, scripted, throws }) => {
      const journal = new MemoryJournal();
      const bus = new LocalEventBus();
      const inbox = new LocalInbox();
      const exec = new LanguageModelExecutor(harnessId, journal, bus, inbox, {
        adapter: chatjimmy(undefined, {
          clientOptions: {
            fetch: throws !== undefined ? throwingFetch(throws) : stubFetch(bodyFor(scripted)),
          },
        }),
      });
      await exec.ready;
      return { executor: exec, bus };
    },
    {
      ProviderRejected: [
        new ChatJimmyHttpError(429, '{"success":false,"error":"rate limited"}'),
        new ChatJimmyHttpError(500, '{"success":false,"error":"Expected text/event-stream"}'),
      ],
      ProviderAborted: [
        Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
      ],
      StreamFailed: [new TypeError("fetch failed")],
      MalformedModelOutput: "not-applicable",
      ProviderTimeout: [Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" })],
    },
  );
});
