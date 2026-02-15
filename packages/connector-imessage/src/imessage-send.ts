import { execFile } from "node:child_process";

/**
 * Send an iMessage via AppleScript.
 *
 * Uses `osascript` to drive Messages.app. The handle can be a phone
 * number (with country code) or an email address.
 */
export function sendIMessage(handle: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = buildAppleScript(handle, text);

    execFile("osascript", ["-e", script], (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to send iMessage: ${stderr || error.message}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Build the AppleScript to send an iMessage.
 *
 * The message text is escaped to prevent AppleScript injection:
 * - Backslashes are doubled
 * - Double quotes are escaped
 */
export function buildAppleScript(handle: string, text: string): string {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedHandle = handle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  return [
    'tell application "Messages"',
    "  set targetService to 1st service whose service type = iMessage",
    `  set targetBuddy to buddy "${escapedHandle}" of targetService`,
    `  send "${escapedText}" to targetBuddy`,
    "end tell",
  ].join("\n");
}
