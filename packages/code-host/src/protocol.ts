/**
 * The frames that cross between the runtime and its child, and the reader that
 * cuts a byte stream into them.
 *
 * ndjson over pipes rather than node's IPC channel: the child engine is
 * whatever the host app runs, and a wire that is just lines of JSON is one
 * every engine already implements. The same reason keeps the frames plain data
 * — a placement that puts the child behind a socket or inside a jail changes
 * the transport and nothing here.
 *
 * @see ./supervisor.mjs — the other end
 */

import type { CodeThrown } from "@agentick/code";

export interface InitFrame {
  readonly t: "init";
  readonly fns: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ExecFrame {
  readonly t: "exec";
  readonly id: number;
  readonly source: string;
}

export interface CallReturnFrame {
  readonly t: "call-return";
  readonly callId: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export type FrameToChild = InitFrame | ExecFrame | CallReturnFrame;

export interface ReadyFrame {
  readonly t: "ready";
}

export interface CallFrame {
  readonly t: "call";
  readonly callId: number;
  readonly name: string;
  readonly input?: unknown;
}

/**
 * How one program ended. `unmarshalable` is the fourth arm and not a
 * {@link CodeExecuteResult} outcome on purpose: a value that cannot cross as
 * JSON is the MEMBRANE failing, which the contract calls a rejection.
 */
export type DoneBody =
  | { readonly outcome: "returned"; readonly value: unknown }
  | { readonly outcome: "no-value" }
  | { readonly outcome: "threw"; readonly error: CodeThrown }
  | { readonly outcome: "unmarshalable"; readonly detail: string };

export type DoneFrame = { readonly t: "done"; readonly id: number } & DoneBody;

export type FrameFromChild = ReadyFrame | CallFrame | DoneFrame;

/**
 * Cuts the control stream into frames. A line that will not parse is a broken
 * membrane, not a bad program — it raises, and the caller kills the context,
 * because a channel that has lost framing cannot be reasoned about further.
 */
export function frameReader(onFrame: (frame: FrameFromChild) => void): (chunk: Buffer) => void {
  let pending = "";
  return (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.length > 0) onFrame(JSON.parse(line) as FrameFromChild);
    }
  };
}
