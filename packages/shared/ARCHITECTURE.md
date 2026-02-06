# @tentickle/shared Architecture

Platform-independent types shared across all Tentickle packages.

## Wire Protocol (`protocol.ts`)

**This is the single source of truth for client-server communication.**

Both `@tentickle/client` and `@tentickle/server` MUST import protocol types from this package. Never duplicate these types.

### Core Types

```typescript
import {
  // The fundamental unit of communication
  ChannelEvent,
  ChannelEventMetadata,

  // Framework channel names
  FrameworkChannels,  // MESSAGES, EVENTS, CONTROL, RESULT, TOOL_CONFIRMATION

  // Channel payloads
  SessionMessagePayload,
  SessionRenderPayload,
  SessionAbortPayload,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,

  // Connection
  ConnectionMetadata,

  // Session
  SessionState,
  CreateSessionRequest,
  CreateSessionResponse,

  // Errors
  ProtocolError,
  ErrorCodes,
} from "@tentickle/shared";
```

### Framework Channels

```typescript
const FrameworkChannels = {
  MESSAGES: "session:messages",        // Client → Server: user messages
  EVENTS: "session:events",            // Server → Client: stream events
  CONTROL: "session:control",          // Client → Server: tick, abort
  RESULT: "session:result",            // Server → Client: final result
  TOOL_CONFIRMATION: "session:tool_confirmation",  // Bidirectional
};
```

### Message Flow

```
Client                              Server
  │                                   │
  │──── ChannelEvent ────────────────▶│  (MESSAGES, CONTROL, TOOL_CONFIRMATION)
  │     {channel, type, payload}      │
  │                                   │
  │◀──── ChannelEvent ────────────────│  (EVENTS, RESULT, TOOL_CONFIRMATION)
  │     {channel, type, payload}      │
```

### Error Codes

Structured protocol errors use the `ProtocolError` type and `ErrorCodes`:

```typescript
interface ProtocolError {
  code: string;       // Error code from ErrorCodes
  message: string;    // Human-readable description
  details?: Record<string, unknown>;  // Optional context
}

const ErrorCodes = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",      // Session doesn't exist
  SESSION_CLOSED: "SESSION_CLOSED",            // Session has been closed
  NOT_CONNECTED: "NOT_CONNECTED",              // Transport not connected
  TIMEOUT: "TIMEOUT",                          // Operation timed out
  INVALID_MESSAGE: "INVALID_MESSAGE",          // Malformed message
  EXECUTION_ERROR: "EXECUTION_ERROR",          // General execution failure
  SERIALIZATION_ERROR: "SERIALIZATION_ERROR",  // JSON serialization failed
};
```

## Other Modules

- `blocks.ts` - Content block discriminated unions (text, image, tool_use, etc.)
- `messages.ts` - Message types with roles
- `streaming.ts` - Stream event types
- `tools.ts` - Tool definitions and execution types
- `models.ts` - Model identifiers
- `errors.ts` - Error types

## Usage

```typescript
// Always import protocol types from shared
import type { ChannelEvent, SessionResultPayload } from "@tentickle/shared";
import { FrameworkChannels } from "@tentickle/shared";

// Never duplicate these types in client or server packages
```
