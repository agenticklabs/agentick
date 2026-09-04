/**
 * `RequestStateCodec` — seals a durable request's thin HANDLE into the opaque
 * wire token MRTR (SEP-2322) calls `requestState`, and opens it on retry.
 *
 * The token is NOT the durable state (that lives store-driven in the
 * `PendingRequestStore`); it is a sealed pointer + authorization: enough to
 * locate the pending record (`correlationId`) and to satisfy the spec's security
 * rules. Per MRTR §Security, because the handle names a user (`principal`),
 * validate is a MUST, and binding it to that user + re-verifying on resume is a
 * MUST; encryption is a SHOULD "if tampering is a concern". The default codec
 * satisfies all of it with a single AEAD primitive — **AES-256-GCM**, the
 * exemplar the spec itself names — giving confidentiality (the untrusted client
 * cannot read the principal/tenant) and integrity (tampering fails the auth tag)
 * at once.
 *
 * Web Crypto (`globalThis.crypto.subtle`), never `node:crypto` — the same
 * browser-portable discipline as `code/code-hash.ts`. No external dependency.
 * `kid` in the token selects the key, so rotation is a keyring: the current key
 * mints, every listed key verifies, and a retired key drops off after its TTL
 * window — the generalized current/previous signing-key dance.
 */

const IV_BYTES = 12;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * The sealed claims — the whole of what the handle carries. `iat`/`exp` are ms
 * epoch; `round` is the MRTR round the handle was minted for (the finer replay
 * guard the store's `consumedAt` complements). Kept minimal: a pointer plus the
 * authorization facts, never durable state.
 */
export interface RequestStateClaims {
  readonly correlationId: string;
  readonly principal?: string;
  readonly round: number;
  readonly iat: number;
  readonly exp: number;
}

export interface RequestStateCodec {
  /** Seal claims into an opaque, self-contained wire token. */
  mint(claims: RequestStateClaims): Promise<string>;
  /**
   * Open + validate a token. Resolves the claims, or `null` when the token is
   * malformed, sealed under an unknown `kid`, tampered (auth-tag mismatch), or
   * past its `exp`. Never throws on bad input — an untrusted client supplies it.
   */
  verify(token: string): Promise<RequestStateClaims | null>;
}

/** One key in the rotation ring. `secret`: raw 32 bytes, or any string (hashed to 32 via SHA-256). */
export interface RequestStateKey {
  readonly kid: string;
  readonly secret: Uint8Array | string;
}

export interface AesGcmCodecConfig {
  /** The rotation ring — the current key mints; ALL keys verify. Non-empty. */
  readonly keys: readonly RequestStateKey[];
  /** Which `kid` mints new tokens. Defaults to the first key. */
  readonly currentKid?: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns an ArrayBuffer-backed view (`new Uint8Array(n)`), so it satisfies Web
// Crypto's `BufferSource` param under TS 5.7's tightened typed-array generics.
function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// `TextEncoder.encode` types its result as `Uint8Array<ArrayBufferLike>`; copy
// into a fresh ArrayBuffer-backed view so Web Crypto accepts it.
function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(textEncoder.encode(value));
}

/**
 * The imported AES key type, derived from the Web Crypto API in scope — avoids
 * naming the DOM-lib `AesKey` global, which not every consuming tsconfig has.
 */
type AesKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

async function importAesKey(secret: Uint8Array | string): Promise<AesKey> {
  const raw =
    typeof secret === "string"
      ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", utf8(secret)))
      : new Uint8Array(secret);
  return globalThis.crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * The default {@link RequestStateCodec}: AES-256-GCM over `kid.iv.ciphertext`
 * (three base64url segments). Keys are imported + cached lazily on first use.
 */
export function createRequestStateCodec(config: AesGcmCodecConfig): RequestStateCodec {
  if (config.keys.length === 0) {
    throw new Error("createRequestStateCodec requires at least one key");
  }
  const currentKid = config.currentKid ?? config.keys[0]!.kid;
  if (!config.keys.some((k) => k.kid === currentKid)) {
    throw new Error(`createRequestStateCodec: currentKid "${currentKid}" is not in keys`);
  }
  const secretByKid = new Map(config.keys.map((k) => [k.kid, k.secret] as const));
  const keyCache = new Map<string, Promise<AesKey>>();

  function keyFor(kid: string): Promise<AesKey> | undefined {
    const secret = secretByKid.get(kid);
    if (secret === undefined) return undefined;
    let cached = keyCache.get(kid);
    if (cached === undefined) {
      cached = importAesKey(secret);
      keyCache.set(kid, cached);
    }
    return cached;
  }

  return {
    async mint(claims: RequestStateClaims): Promise<string> {
      const key = await keyFor(currentKid)!;
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          utf8(JSON.stringify(claims)),
        ),
      );
      return [
        base64UrlEncode(textEncoder.encode(currentKid)),
        base64UrlEncode(iv),
        base64UrlEncode(ciphertext),
      ].join(".");
    },

    async verify(token: string): Promise<RequestStateClaims | null> {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      let claims: RequestStateClaims;
      try {
        const kid = textDecoder.decode(base64UrlDecode(parts[0]!));
        const keyPromise = keyFor(kid);
        if (keyPromise === undefined) return null;
        const key = await keyPromise;
        const plaintext = await globalThis.crypto.subtle.decrypt(
          { name: "AES-GCM", iv: base64UrlDecode(parts[1]!) },
          key,
          base64UrlDecode(parts[2]!),
        );
        claims = JSON.parse(textDecoder.decode(plaintext)) as RequestStateClaims;
      } catch {
        return null;
      }
      if (typeof claims.correlationId !== "string" || typeof claims.exp !== "number") return null;
      if (claims.exp < Date.now()) return null;
      return claims;
    },
  };
}
