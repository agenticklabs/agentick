/**
 * Differential drop detection, against adapters that drop on purpose.
 *
 * The mechanism observes BEHAVIOUR rather than asking for a claim, so the fixtures here
 * are deliberately adversarial: adapters that drop silently, adapters that drop a whole
 * message, adapters that carry everything, and — the case this cannot see — an adapter
 * that carries an input in a form the provider would reject.
 */

import { describe, expect, it } from "vitest";
import type { ExecutionTarget, LanguageModelInput, LanguageModelMessagePart } from "@agentick/spec";

import { detectDroppedInputs, type ProjectingAdapter } from "../dropped-inputs.js";
import { buildMessageProvenance, buildMessages } from "../index.js";

const TARGET: ExecutionTarget = { kind: "language-model", provider: "stub", modelId: "stub-v1" };

const text = (t: string): LanguageModelMessagePart => ({ type: "text", text: t });
const image = (url: string): LanguageModelMessagePart =>
  ({ type: "image", source: { type: "url", url } }) as LanguageModelMessagePart;
const audio = (data: string): LanguageModelMessagePart =>
  ({ type: "audio", source: { type: "base64", data } }) as LanguageModelMessagePart;

const input = (
  content: readonly LanguageModelMessagePart[],
  rest: Partial<LanguageModelInput> = {},
): LanguageModelInput => ({ messages: [{ role: "user", content }], ...rest });

/**
 * An adapter whose projection keeps only the part types in `keeps` — the shape of every
 * real adapter's media switch, with the arms it lacks made explicit.
 */
function adapterKeeping(keeps: readonly string[], opts: { params?: readonly string[] } = {}) {
  const adapter: ProjectingAdapter = {
    provider: "stub",
    target: TARGET,
    prepareRequest({ targetInput }) {
      const parameters = targetInput.parameters;
      const carriedKeys = opts.params ?? (parameters ? Object.keys(parameters) : []);
      return {
        messages: targetInput.messages.map((m) => ({
          role: m.role,
          content: m.content.filter((p) => keeps.includes(p.type)),
        })),
        ...(parameters
          ? {
              params: Object.fromEntries(
                Object.entries(parameters).filter(([k]) => carriedKeys.includes(k)),
              ),
            }
          : {}),
        ...(targetInput.tools ? { tools: targetInput.tools.map((t) => t.name) } : {}),
      };
    },
  };
  return adapter;
}

describe("detecting a silently dropped part", () => {
  it("finds the one part type the adapter has no arm for", () => {
    const adapter = adapterKeeping(["text", "image"]);
    const result = detectDroppedInputs(adapter, input([text("hi"), image("u"), audio("AAAA")]));
    expect(result.parts).toEqual([{ messageIndex: 0, partIndex: 2, partType: "audio" }]);
  });

  it("reports nothing for a faithful adapter", () => {
    const adapter = adapterKeeping(["text", "image", "audio"]);
    const result = detectDroppedInputs(adapter, input([text("hi"), image("u"), audio("AAAA")]));
    expect(result.parts).toEqual([]);
    expect(result.parameters).toEqual([]);
  });

  it("finds a SOLO dropped part, where removing it also empties the message", () => {
    // The case that looks like a confound and is not: if the part had been dropped, the
    // adapter produces the same request for "message with a dropped part" as for
    // "message with no parts". Only a CARRIED part makes those differ.
    const adapter = adapterKeeping(["text"]);
    const result = detectDroppedInputs(adapter, input([audio("AAAA")]));
    expect(result.parts).toEqual([{ messageIndex: 0, partIndex: 0, partType: "audio" }]);
  });

  it("still finds it when the adapter drops the emptied MESSAGE too", () => {
    const adapter: ProjectingAdapter = {
      provider: "stub",
      target: TARGET,
      prepareRequest({ targetInput }) {
        return {
          messages: targetInput.messages
            .map((m) => ({ role: m.role, content: m.content.filter((p) => p.type === "text") }))
            .filter((m) => m.content.length > 0),
        };
      },
    };
    expect(detectDroppedInputs(adapter, input([audio("AAAA")])).parts).toEqual([
      { messageIndex: 0, partIndex: 0, partType: "audio" },
    ]);
  });

  it("finds every dropped part across several messages", () => {
    const adapter = adapterKeeping(["text"]);
    const result = detectDroppedInputs(adapter, {
      messages: [
        { role: "user", content: [text("a"), image("u1")] },
        { role: "assistant", content: [text("b")] },
        { role: "user", content: [image("u2"), text("c")] },
      ],
    });
    expect(result.parts).toEqual([
      { messageIndex: 0, partIndex: 1, partType: "image" },
      { messageIndex: 2, partIndex: 0, partType: "image" },
    ]);
  });

  it("does not confuse two IDENTICAL parts for one drop", () => {
    // Removing one of a duplicated pair still changes the request (one fewer), so both
    // are correctly reported as carried. A value-keyed implementation would trip here.
    const adapter = adapterKeeping(["text"]);
    expect(detectDroppedInputs(adapter, input([text("same"), text("same")])).parts).toEqual([]);
  });
});

describe("detecting a dropped PARAMETER — the responseFormat class", () => {
  it("finds a canonical knob the adapter ignores", () => {
    // An adopter asked for structured output and got prose, with no error anywhere. This
    // is the failure the four existing TODOs in this repo describe, made observable.
    const adapter = adapterKeeping(["text"], { params: ["temperature"] });
    const result = detectDroppedInputs(
      adapter,
      input([text("hi")], { parameters: { temperature: 0.5, responseFormat: { type: "json" } } }),
    );
    expect(result.parameters).toEqual(["responseFormat"]);
  });

  it("reports nothing when every knob is carried", () => {
    const adapter = adapterKeeping(["text"]);
    const result = detectDroppedInputs(
      adapter,
      input([text("hi")], { parameters: { temperature: 0.5, topP: 0.9 } }),
    );
    expect(result.parameters).toEqual([]);
  });

  it("is silent when there are no parameters at all", () => {
    expect(detectDroppedInputs(adapterKeeping(["text"]), input([text("hi")])).parameters).toEqual(
      [],
    );
  });
});

describe("detecting a dropped TOOL", () => {
  it("names a tool that never reached the wire", () => {
    const adapter: ProjectingAdapter = {
      provider: "stub",
      target: TARGET,
      prepareRequest({ targetInput }) {
        return {
          messages: targetInput.messages,
          tools: (targetInput.tools ?? []).filter((t) => t.name !== "forbidden").map((t) => t.name),
        };
      },
    };
    const result = detectDroppedInputs(
      adapter,
      input([text("hi")], {
        tools: [
          { name: "ok", inputSchema: { type: "object" } },
          { name: "forbidden", inputSchema: { type: "object" } },
        ],
      }),
    );
    expect(result.tools).toEqual(["forbidden"]);
  });
});

describe("what it cannot see, stated plainly", () => {
  it("does NOT flag an input carried in a form the provider would reject", () => {
    // The original `fileUri: "<uuid>"` bug. The request DID change, so nothing was
    // dropped — this mechanism is blind to it by construction, and `capabilities.media`
    // is what covers it. Pinned so nobody mistakes silence here for safety.
    const corrupting: ProjectingAdapter = {
      provider: "stub",
      target: TARGET,
      prepareRequest({ targetInput }) {
        return {
          messages: targetInput.messages.map((m) => ({
            role: m.role,
            // An adopter file id emitted as if it were a URL — invalid, but present.
            content: m.content.map((p) => (p.type === "image" ? { url: "not-a-url" } : p)),
          })),
        };
      },
    };
    expect(detectDroppedInputs(corrupting, input([image("u")])).parts).toEqual([]);
  });
});

describe("joining a drop to the timeline entry that produced it", () => {
  it("names the durable entry id, not a wire position", () => {
    // Why the coordinates are `(messageIndex, partIndex)`: they are provenance's
    // coordinates, so a drop becomes an entry id an application can act on ONCE.
    const tree = {
      specVersion: "2026-05-08",
      context: {
        entries: [
          { kind: "message", role: "user", id: "m_1", content: [{ type: "text", text: "look" }] },
          {
            kind: "message",
            role: "user",
            id: "m_9",
            content: [
              { type: "text", text: "and this" },
              { type: "audio", source: { type: "base64", data: "AAAA" } },
            ],
          },
        ],
      },
    } as never;

    const messages = buildMessages(tree);
    const provenance = buildMessageProvenance(tree);
    const { parts } = detectDroppedInputs(adapterKeeping(["text"]), { messages });

    expect(parts.map((p) => provenance[p.messageIndex]?.[p.partIndex])).toEqual([
      { entryId: "m_9", blockIndex: 1 },
    ]);
  });
});
