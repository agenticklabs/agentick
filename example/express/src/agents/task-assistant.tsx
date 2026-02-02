/**
 * Task Assistant Agent
 *
 * A helpful assistant with access to todo list and calculator tools.
 * Demonstrates:
 * - JSX component composition
 * - Dynamic model selection
 * - Tool integration
 * - Timeline rendering
 */

import { Model, Section, Timeline, Message } from "@tentickle/core";
import { useComputed, useComState } from "@tentickle/core";
import type { MessageRoles, ModelMessage } from "@tentickle/shared";
import { openai } from "@tentickle/openai";
import { google } from "@tentickle/google";
import { TodoListTool } from "../tools/todo-list.tool.js";
import { CalculatorTool } from "../tools/calculator.tool.js";

// Parse Google credentials if provided
const GOOGLE_CREDENTIALS = process.env["GCP_CREDENTIALS"]
  ? JSON.parse(Buffer.from(process.env["GCP_CREDENTIALS"], "base64").toString("utf8"))
  : undefined;

/**
 * Dynamic model component that switches between OpenAI and Google based on config.
 */
function DynamicModel() {
  const useGoogle = useComState<boolean>("useGoogle", process.env["USE_GOOGLE_MODEL"] === "true");
  const openaiModelName = useComState<string>(
    "openaiModel",
    process.env["OPENAI_MODEL"] || "gpt-4o-mini",
  );
  const googleModelName = useComState<string>(
    "googleModel",
    process.env["GOOGLE_MODEL"] || "gemini-2.0-flash",
  );

  const model = useComputed(() => {
    if (useGoogle()) {
      return google({
        model: googleModelName(),
        apiKey: process.env["GOOGLE_API_KEY"],
        vertexai: !!process.env["GCP_PROJECT_ID"],
        project: process.env["GCP_PROJECT_ID"],
        location: process.env["GCP_LOCATION"] || "us-central1",
        googleAuthOptions: GOOGLE_CREDENTIALS ? { credentials: GOOGLE_CREDENTIALS } : undefined,
      });
    } else {
      return openai({
        model: openaiModelName(),
        apiKey: process.env["OPENAI_API_KEY"],
        baseURL: process.env["OPENAI_BASE_URL"],
      });
    }
  }, [useGoogle, googleModelName, openaiModelName]);

  return <Model model={model()} />;
}

/**
 * Main Task Assistant agent component.
 */
export function TaskAssistantAgent() {
  return (
    <>
      {/* Model configuration */}
      <DynamicModel />

      {/* System instructions */}
      <Section id="instructions" audience="model">
        You are a helpful task management assistant. You have access to: 1. **Todo List Tool** -
        Create, update, complete, and delete tasks 2. **Calculator Tool** - Perform mathematical
        calculations IMPORTANT RULES: - When asked to manage tasks, ALWAYS use the todo_list tool -
        When asked to calculate, ALWAYS use the calculator tool - Be concise and helpful in your
        responses - After using a tool, briefly confirm what you did Examples: - "Add a task to buy
        groceries" → Use todo_list with action: create - "Mark task 1 as done" → Use todo_list with
        action: complete - "What is 42 * 17?" → Use calculator with expression: "42 * 17"
      </Section>

      {/* Tools */}
      <TodoListTool />
      <CalculatorTool />

      {/* Conversation history + pending messages */}
      <Timeline>
        {(history, pending = []) => (
          <>
            {/* Previous conversation history */}
            {history.map((entry, i) =>
              entry.message ? <Message key={`history-${i}`} {...entry.message} /> : null,
            )}
            {/* Pending messages for this tick */}
            {pending
              ?.filter((msg) => {
                const message = msg.content as ModelMessage | undefined;
                return msg.type === "message" && message?.role && message.content && message.id;
              })
              .map((msg, i) => {
                // ExecutionMessage.content is the Message object
                const message = msg.content as ModelMessage;
                console.log("message", message);
                return <Message key={`pending-${i}`} {...message} />;
              })}
          </>
        )}
      </Timeline>
    </>
  );
}
