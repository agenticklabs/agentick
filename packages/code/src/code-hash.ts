/**
 * The digest that identifies a program in the journal. Web Crypto rather than
 * `node:crypto` so the harness stays free of Node builtins — same reason
 * `generateId` reaches for `globalThis.crypto`.
 */
export async function sha256Hex(source: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
