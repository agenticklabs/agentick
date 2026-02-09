/**
 * Simple agent for testing the TUI.
 *
 * Uses OpenAI by default. Configure via environment variables:
 *   OPENAI_API_KEY  — required
 *   OPENAI_BASE_URL — optional (for proxies / compatible APIs)
 *   OPENAI_MODEL    — optional (default: gpt-4o-mini)
 */

import { Section, Timeline, Message, Model } from "@agentick/core";
import type { ModelMessage } from "@agentick/shared";
import { openai } from "@agentick/openai";

function DynamicModel() {
  const model = openai({
    model: process.env["OPENAI_MODEL"] || "gpt-4o-mini",
    apiKey: process.env["OPENAI_API_KEY"],
    baseURL: process.env["OPENAI_BASE_URL"],
  });
  return <Model model={model} />;
}

export function Agent() {
  return (
    <>
      <DynamicModel />
      <Section id="instructions" audience="model">
        You are a helpful assistant. Be concise in your responses.
      </Section>
      <Timeline>
        {(history, pending = []) => (
          <>
            {history.map((entry, i) =>
              entry.message ? <Message key={`h-${i}`} {...entry.message} /> : null,
            )}
            {pending
              ?.filter((msg) => {
                const message = msg.content as ModelMessage | undefined;
                return msg.type === "message" && message?.role && message?.content && message?.id;
              })
              .map((msg, i) => {
                const message = msg.content as ModelMessage;
                return <Message key={`p-${i}`} {...message} />;
              })}
          </>
        )}
      </Timeline>
    </>
  );
}
