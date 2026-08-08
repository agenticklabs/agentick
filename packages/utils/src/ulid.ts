/**
 * Tiny monotonic id generator. Crockford-style base32 encoding of
 * `timestamp(48) + random(80)`. Not a strict ULID — we don't need the
 * canonical algorithm here; we need lexicographic-sortable, collision-
 * resistant ids that survive JSON round-trips.
 *
 * Lives in `@agentick/utils` rather than `@agentick/runtime`
 * so framework-substrate-agnostic packages (cluster-next, future
 * cluster adapters, transports, etc.) can use it without pulling in
 * the local-substrate impls.
 *
 * If a real case demands strict ULID semantics, swap this for the
 * canonical `ulid` package — implementations of `OperationJournal`
 * / `MessageInbox` MUST NOT depend on the encoding.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, 32 chars

let lastTime = 0;
// Allow either ArrayBuffer or ArrayBufferLike — randomBytes() returns the
// generic form on newer TS lib targets.
let lastRandom: Uint8Array<ArrayBufferLike> = new Uint8Array(10);

function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function encodeTime(time: number): string {
  const buf = new Uint8Array(6);
  let t = time;
  for (let i = 5; i >= 0; i--) {
    buf[i] = t & 0xff;
    t = Math.floor(t / 256);
  }
  return encodeBase32(buf).slice(0, 10);
}

function randomBytes(): Uint8Array {
  const out = new Uint8Array(10);
  const g = globalThis.crypto;
  if (g?.getRandomValues === undefined) {
    throw new Error(
      "ulid(): globalThis.crypto.getRandomValues is unavailable. Falling back to " +
        "Math.random() would silently drop collision resistance, and these ids key " +
        "journal entries and message envelopes.",
    );
  }
  g.getRandomValues(out);
  return out;
}

function bumpRandom(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] === 0xff) {
      out[i] = 0;
    } else {
      out[i] = out[i]! + 1;
      return out;
    }
  }
  // Every byte was 0xff, so the carry ran off the end and `out` is now all
  // zeros — an id that sorts BEFORE its predecessor. Needs 2^80 same-ms calls,
  // so this is a guard rather than a real path; a wrong order is worse than a
  // throw, because nothing downstream re-checks it.
  throw new Error("ulid(): random suffix overflowed within a single millisecond");
}

/**
 * Generate a lexicographically-sortable id. Monotonic within a process
 * when called repeatedly at the same millisecond.
 */
export function ulid(): string {
  const now = Date.now();
  // `lastTime` is a monotonic FLOOR, not the raw clock. `Date.now()` steps
  // backward on NTP correction, VM migration and leap-second smearing; taking
  // it verbatim would emit a smaller time prefix, and the id would sort before
  // ids already handed out. The journal's ordering and every cursored read are
  // exactly that assumption, and neither re-checks it.
  if (now > lastTime) {
    lastTime = now;
    lastRandom = randomBytes();
  } else {
    lastRandom = bumpRandom(lastRandom);
  }
  return encodeTime(lastTime) + encodeBase32(lastRandom).slice(0, 16);
}
