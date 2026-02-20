/**
 * NDJSON Line Buffer
 *
 * Accumulates raw TCP/socket data and emits complete JSON lines.
 * Handles partial lines across `data` events. Used by both the
 * Unix socket server transport and client transport.
 *
 * Protocol: JSON.stringify escapes internal newlines, so raw \n
 * is an unambiguous message delimiter.
 */

export class LineBuffer {
  private buffer = "";

  /** Feed raw data, returns array of complete lines */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        lines.push(line);
      }
    }
    return lines;
  }
}
