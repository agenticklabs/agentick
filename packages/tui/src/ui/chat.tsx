/**
 * Chat — default TUI layout.
 *
 * Orchestrates the conversation: message history, streaming response,
 * tool call indicators, tool confirmation prompts, error display, and user input.
 *
 * State machine: idle → streaming → (confirming_tool → streaming) → idle
 * Ctrl+C behavior depends on state:
 *   - idle: exit the process
 *   - streaming: abort current execution
 *   - confirming_tool: reject tool, return to streaming
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useSession, useStreamingText } from "@agentick/react";
import type { ToolConfirmationRequest, ToolConfirmationResponse } from "@agentick/client";
import { MessageList } from "../components/MessageList.js";
import { StreamingMessage } from "../components/StreamingMessage.js";
import { ToolCallIndicator } from "../components/ToolCallIndicator.js";
import { ToolConfirmationPrompt } from "../components/ToolConfirmationPrompt.js";
import { ErrorDisplay } from "../components/ErrorDisplay.js";
import { InputBar } from "../components/InputBar.js";
import { useSlashCommands, helpCommand, exitCommand } from "../commands.js";
import { useCommandsConfig } from "../commands-context.js";

interface ChatProps {
  sessionId: string;
}

type ChatState = "idle" | "streaming" | "confirming_tool";

interface ToolConfirmationState {
  request: ToolConfirmationRequest;
  respond: (response: ToolConfirmationResponse) => void;
}

export function Chat({ sessionId }: ChatProps) {
  const { exit } = useApp();
  const { send, abort, accessor } = useSession({ sessionId, autoSubscribe: true });
  const { isStreaming } = useStreamingText();

  const [chatState, setChatState] = useState<ChatState>("idle");
  const [toolConfirmation, setToolConfirmation] = useState<ToolConfirmationState | null>(null);
  const [error, setError] = useState<Error | string | null>(null);

  // Sync streaming state → chatState (unless we're in confirming_tool, which takes priority)
  useEffect(() => {
    if (isStreaming && chatState === "idle") {
      setChatState("streaming");
      setError(null); // Clear previous errors on new execution
    } else if (!isStreaming && chatState === "streaming") {
      setChatState("idle");
    }
  }, [isStreaming, chatState]);

  // Register tool confirmation handler
  useEffect(() => {
    if (!accessor) return;
    return accessor.onToolConfirmation((request, respond) => {
      setToolConfirmation({ request, respond });
      setChatState("confirming_tool");
    });
  }, [accessor]);

  // Ctrl+C handling
  useInput((_input, key) => {
    if (!key.ctrl || _input !== "c") return;

    if (chatState === "idle") {
      exit();
    } else if (chatState === "streaming") {
      abort();
      setChatState("idle");
    } else if (chatState === "confirming_tool" && toolConfirmation) {
      toolConfirmation.respond({ approved: false, reason: "cancelled by user" });
      setToolConfirmation(null);
      setChatState("streaming");
    }
  });

  const configCommands = useCommandsConfig();
  const commandCtx = useMemo(
    () => ({ sessionId, send, abort, output: console.log }),
    [sessionId, send, abort],
  );
  const { dispatch } = useSlashCommands(
    [...configCommands, helpCommand(), exitCommand(exit)],
    commandCtx,
  );

  const handleSubmit = useCallback(
    (text: string) => {
      if (dispatch(text)) return;
      setError(null);
      try {
        send(text);
      } catch (err) {
        setError(err instanceof Error ? err : String(err));
      }
    },
    [dispatch, send],
  );

  const handleToolConfirmationResponse = useCallback(
    (response: ToolConfirmationResponse) => {
      if (toolConfirmation) {
        toolConfirmation.respond(response);
        setToolConfirmation(null);
        setChatState("streaming");
      }
    },
    [toolConfirmation],
  );

  const handleErrorDismiss = useCallback(() => {
    setError(null);
  }, []);

  const isInputDisabled = chatState !== "idle";
  const placeholder =
    chatState === "streaming"
      ? "Waiting for response... (Ctrl+C to abort)"
      : chatState === "confirming_tool"
        ? "Confirm or reject the tool above..."
        : undefined;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          agentick
        </Text>
        <Text color="gray"> — type /help for commands</Text>
      </Box>

      <MessageList sessionId={sessionId} />
      <StreamingMessage />
      <ToolCallIndicator sessionId={sessionId} />

      {chatState === "confirming_tool" && toolConfirmation && (
        <ToolConfirmationPrompt
          request={toolConfirmation.request}
          onRespond={handleToolConfirmationResponse}
        />
      )}

      <ErrorDisplay error={error} onDismiss={handleErrorDismiss} />

      <Box marginTop={1}>
        <InputBar onSubmit={handleSubmit} isDisabled={isInputDisabled} placeholder={placeholder} />
      </Box>
    </Box>
  );
}
