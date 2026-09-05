import { describe, expect, it } from "vitest";

import { generate, generateStream } from "@agentick/model";
import type { ExecuteInput, LanguageModelInput } from "@agentick/spec";

import { chatjimmy, ChatJimmyHttpError, DEFAULT_CHATJIMMY_MODEL } from "../chatjimmy-adapter.js";
import { splitStatsTrailer, StatsTrailerSplitter } from "../stats-trailer.js";
import { statsTrailer, stubFetch } from "./stub-fetch.js";

const STATS = {
  done: true,
  done_reason: "stop",
  prefill_tokens: 13,
  decode_tokens: 10,
  total_tokens: 23,
  ttft: 0.0009,
};

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

const executeInput = (
  input: Partial<LanguageModelInput>,
  target = chatjimmy().target,
): ExecuteInput<LanguageModelInput> => ({
  targetInput: { messages: [user("hi")], ...input },
  target,
});

describe("stats trailer", () => {
  it("splits text from the trailer and parses it", () => {
    const { text, stats } = splitStatsTrailer(`Hi there.\n${statsTrailer(STATS)}`);
    expect(text).toBe("Hi there.\n");
    expect(stats).toEqual(STATS);
  });

  it("delivers a marker split across chunks as one trailer, and the text before it intact", () => {
    const splitter = new StatsTrailerSplitter();
    const first = splitter.push("Hello <|st");
    const second = splitter.push(`ats|>${JSON.stringify(STATS).slice(0, 10)}`);
    const third = splitter.push(`${JSON.stringify(STATS).slice(10)}<|/stats|>`);
    expect(first.text + second.text + third.text).toBe("Hello ");
    expect(third.stats).toEqual(STATS);
    expect(splitter.flush()).toBe("");
  });

  it("a stray '<' at the end of the stream is text, not a marker", () => {
    const splitter = new StatsTrailerSplitter();
    expect(splitter.push("a < b <|").text).toBe("a < b ");
    expect(splitter.flush()).toBe("<|");
  });

  it("an unparseable trailer yields text with no stats", () => {
    expect(splitStatsTrailer("ok<|stats|>not json<|/stats|>")).toEqual({ text: "ok" });
  });
});

describe("chatjimmy() — request assembly", () => {
  it("lowers roles onto the three the wire has and flattens tool parts to text", () => {
    const request = chatjimmy().prepareRequest(
      executeInput({
        messages: [
          { role: "system", content: [{ type: "text", text: "Be terse." }] },
          { role: "grounding", content: [{ type: "text", text: "Today is Monday." }] },
          user("what day is it?"),
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c1", name: "lookup", input: { q: "day" } }],
          },
          {
            role: "tool",
            content: [
              { type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "Monday" }] },
            ],
          },
          { role: "event", content: [{ type: "text", text: "user opened the calendar" }] },
        ],
      }),
    );
    expect(request.messages).toEqual([
      { role: "system", content: "Be terse." },
      { role: "system", content: "Today is Monday." },
      { role: "user", content: "what day is it?" },
      { role: "assistant", content: '[tool_use lookup] {"q":"day"}' },
      { role: "user", content: "Monday" },
      { role: "user", content: "user opened the calendar" },
    ]);
    expect(request.attachment).toBeNull();
  });

  it("chatOptions carry the target's model id, the site's topK default, and an empty system prompt", () => {
    expect(chatjimmy().prepareRequest(executeInput({})).chatOptions).toEqual({
      selectedModel: DEFAULT_CHATJIMMY_MODEL,
      systemPrompt: "",
      topK: 8,
    });
    const overridden = chatjimmy("other-model", { topK: 3 });
    expect(overridden.prepareRequest(executeInput({}, overridden.target)).chatOptions).toEqual({
      selectedModel: "other-model",
      systemPrompt: "",
      topK: 3,
    });
  });

  it("providerOptions.chatjimmy overrides chatOptions, tree over target", () => {
    const adapter = chatjimmy(undefined, {
      providerOptions: { chatjimmy: { systemPrompt: "from target", topK: 2 } },
    });
    const request = adapter.prepareRequest(
      executeInput(
        { providerOptions: { chatjimmy: { systemPrompt: "from tree" } } },
        adapter.target,
      ),
    );
    expect(request.chatOptions).toEqual({
      selectedModel: DEFAULT_CHATJIMMY_MODEL,
      systemPrompt: "from tree",
      topK: 2,
    });
  });
});

describe("chatjimmy() — the wire", () => {
  it("posts to <baseURL>/api/chat with the site's headers plus the caller's", async () => {
    const fetchImpl = stubFetch(`OK${statsTrailer(STATS)}`);
    const model = chatjimmy(undefined, {
      clientOptions: {
        fetch: fetchImpl,
        baseURL: "https://example.test/",
        headers: { "X-Trace": "1" },
      },
    });
    await generate({ model, messages: [user("say ok")] });
    const [call] = fetchImpl.calls;
    expect(call!.url).toBe("https://example.test/api/chat");
    expect(call!.headers).toMatchObject({
      "Content-Type": "application/json",
      Origin: "https://chatjimmy.ai",
      Referer: "https://chatjimmy.ai/",
      "X-Trace": "1",
    });
    expect(call!.body).toEqual({
      messages: [{ role: "user", content: "say ok" }],
      chatOptions: { selectedModel: DEFAULT_CHATJIMMY_MODEL, systemPrompt: "", topK: 8 },
      attachment: null,
    });
  });

  it("non-streaming: text becomes one block, the trailer becomes usage and stop reason", async () => {
    const model = chatjimmy(undefined, {
      clientOptions: {
        fetch: stubFetch(`Hi!${statsTrailer({ ...STATS, done_reason: "length" })}`),
      },
    });
    const result = await generate({ model, messages: [user("hi")] });
    expect(result.output).toEqual([{ type: "text", text: "Hi!" }]);
    expect(result.stopReason).toBe("max_tokens");
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 10, totalTokens: 23 });
  });

  it("streaming: chunks fold to the same result, with the trailer never reaching the text", async () => {
    const model = chatjimmy(undefined, {
      clientOptions: {
        fetch: stubFetch(["Hel", "lo <|st", `ats|>${JSON.stringify(STATS)}<|/st`, "ats|>"]),
      },
    });
    const handle = generateStream({ model, messages: [user("hi")] });
    const deltas: string[] = [];
    for await (const delta of handle.stream) {
      if (delta.type === "content-delta") deltas.push(delta.delta);
    }
    const result = await handle.result;
    expect(deltas.join("")).toBe("Hello ");
    expect(result.output).toEqual([{ type: "text", text: "Hello " }]);
    expect(result.stopReason).toBe("end");
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 10, totalTokens: 23 });
  });

  it("a non-2xx answer throws with the status the executor classifies on", async () => {
    const model = chatjimmy(undefined, {
      clientOptions: { fetch: stubFetch('{"success":false,"error":"boom"}', { status: 500 }) },
    });
    await expect(generate({ model, messages: [user("hi")] })).rejects.toMatchObject({
      name: "ChatJimmyHttpError",
      status: 500,
      body: '{"success":false,"error":"boom"}',
    });
    expect(new ChatJimmyHttpError(429, "").message).toBe("chatjimmy: HTTP 429");
  });
});
