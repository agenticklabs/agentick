/**
 * Chat — default TUI layout and single input orchestrator.
 *
 * Uses useChat with renderMode: "block" — content blocks appear as they
 * complete, while StreamingMessage shows token-by-token text for the
 * current block being streamed.
 *
 * State machine: idle → streaming → (confirming_tool → streaming) → idle
 * Ctrl+C behavior depends on state:
 *   - idle: exit the process
 *   - streaming: abort current execution
 *   - confirming_tool: reject tool, return to streaming
 *
 * Input routing priority:
 *   1. Ctrl+C → always handled (abort/exit/reject based on state)
 *   2. confirming_tool → Y/N/A keys via handleConfirmationKey
 *   3. error displayed → any key dismisses
 *   4. idle → editor.handleInput
 */

import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Box, useApp, useInput } from "ink";
import { useChat, useStreamingText } from "@agentick/react";
import type { ChatMode } from "@agentick/client";
import { MessageList } from "../components/MessageList.js";
import { StreamingMessage } from "../components/StreamingMessage.js";
import { ToolCallIndicator } from "../components/ToolCallIndicator.js";
import { ToolConfirmationPrompt } from "../components/ToolConfirmationPrompt.js";
import { ErrorDisplay } from "../components/ErrorDisplay.js";
import { InputBar } from "../components/InputBar.js";
import { DefaultStatusBar } from "../components/status-bar/DefaultStatusBar.js";
import { useSlashCommands, helpCommand, exitCommand } from "../commands.js";
import { useCommandsConfig } from "../commands-context.js";
import { useLineEditor } from "../hooks/use-line-editor.js";
import { handleConfirmationKey } from "../input-utils.js";

export interface ChatStatusBarState {
  mode: ChatMode;
  isExecuting: boolean;
  sessionId: string;
}

interface ChatProps {
  sessionId: string;
  /**
   * Status bar configuration:
   * - `false`: no status bar
   * - `ReactNode`: custom static status bar
   * - `(state) => ReactNode`: render prop with chat state
   * - `undefined` (default): `<DefaultStatusBar>` wired to chat state
   */
  statusBar?: false | ReactNode | ((state: ChatStatusBarState) => ReactNode);
}

export function Chat({ sessionId, statusBar }: ChatProps) {
  const { exit } = useApp();

  const {
    messages,
    chatMode,
    toolConfirmation,
    isExecuting,
    error,
    submit,
    abort,
    respondToConfirmation,
  } = useChat({
    sessionId,
    renderMode: "block",
  });

  // StreamingMessage still uses useStreamingText for live token display
  const { isStreaming } = useStreamingText();

  const [dismissedError, setDismissedError] = useState(false);
  // Track the error identity so dismissal resets on new errors
  const displayError = error && !dismissedError ? error.message : null;

  const configCommands = useCommandsConfig();
  const commandCtx = useMemo(
    () => ({ sessionId, send: (text: string) => submit(text), abort, output: console.log }),
    [sessionId, submit, abort],
  );
  const { dispatch } = useSlashCommands(
    [...configCommands, helpCommand(), exitCommand(exit)],
    commandCtx,
  );

  const handleSubmit = useCallback(
    (text: string) => {
      if (dispatch(text)) return;
      setDismissedError(false);
      submit(text);
    },
    [dispatch, submit],
  );

  const handleToolConfirmationResponse = useCallback(
    (response: { approved: boolean; reason?: string }) => {
      respondToConfirmation(response);
    },
    [respondToConfirmation],
  );

  const handleErrorDismiss = useCallback(() => {
    setDismissedError(true);
  }, []);

  // Chat owns the line editor directly
  const editor = useLineEditor({ onSubmit: handleSubmit });

  // Single centralized input handler — all keystrokes route through here
  useInput((input, key) => {
    // 1. Ctrl+C → always handled
    if (key.ctrl && input === "c") {
      if (chatMode === "idle") {
        exit();
      } else if (chatMode === "streaming") {
        abort();
      } else if (chatMode === "confirming_tool" && toolConfirmation) {
        respondToConfirmation({ approved: false, reason: "cancelled by user" });
      }
      return;
    }

    // 2. Tool confirmation → Y/N/A
    if (chatMode === "confirming_tool" && toolConfirmation) {
      handleConfirmationKey(input, handleToolConfirmationResponse);
      return;
    }

    // 3. Error displayed → any key dismisses
    if (displayError && chatMode === "idle") {
      handleErrorDismiss();
      return;
    }

    // 4. Idle → route to editor
    if (chatMode === "idle") {
      editor.handleInput(input, key);
    }
  });

  const isInputActive = chatMode === "idle";
  const placeholder =
    chatMode === "streaming"
      ? "Waiting for response... (Ctrl+C to abort)"
      : chatMode === "confirming_tool"
        ? "Confirm or reject the tool above..."
        : undefined;

  // Resolve status bar content
  let statusBarContent: ReactNode;
  if (statusBar === false) {
    statusBarContent = null;
  } else if (typeof statusBar === "function") {
    statusBarContent = statusBar({ mode: chatMode, isExecuting: isStreaming, sessionId });
  } else if (statusBar !== undefined) {
    statusBarContent = statusBar;
  } else {
    statusBarContent = (
      <DefaultStatusBar sessionId={sessionId} mode={chatMode} isExecuting={isStreaming} />
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <MessageList messages={messages} isExecuting={isExecuting} />
      <StreamingMessage />
      <ToolCallIndicator sessionId={sessionId} />

      {chatMode === "confirming_tool" && toolConfirmation && (
        <ToolConfirmationPrompt request={toolConfirmation.request} />
      )}

      <ErrorDisplay error={displayError} showDismissHint={!!displayError && chatMode === "idle"} />

      <Box marginTop={1}>
        <InputBar
          value={editor.value}
          cursor={editor.cursor}
          isActive={isInputActive}
          placeholder={placeholder}
        />
      </Box>

      {statusBarContent}
    </Box>
  );
}
