/**
 * `generateId()` — the id every journal entry, envelope and mount id rides,
 * and the seam for replacing it.
 *
 * The default is a monotonic Crockford-base32 encoding of
 * `timestamp(48) + random(80)`. Not a strict ULID: the timestamp pads at the
 * back rather than the front, so these do not decode in a canonical ULID
 * parser. That is deliberate and load-bearing only in one direction — ids must
 * SORT correctly; nothing reads a timestamp back out of one.
 *
 * Lives in `@agentick/utils` rather than `@agentick/runtime` so
 * substrate-agnostic packages (cluster adapters, transports) can use it
 * without pulling in the local-substrate impls.
 *
 * @see {@link setIdGenerator} for the contract a replacement must honour, and
 * `@agentick/utils/testing`'s `assertIdGeneratorConformance` for the
 * suite that checks one.
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
      "generateId(): globalThis.crypto.getRandomValues is unavailable. Falling back to " +
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
  throw new Error("generateId(): random suffix overflowed within a single millisecond");
}

/**
 * Produces the next id. Must satisfy the contract in {@link setIdGenerator}.
 */
export type IdGenerator = () => string;

let generate: IdGenerator = defaultGenerator;

/**
 * Replace the process-wide id generator.
 *
 * The contract is NOT "returns a unique string" — it is:
 *
 *   1. **Monotonic.** Each id sorts strictly after the one before it, for the
 *      life of the process.
 *   2. **Lexicographically sortable.** Plain string `<` on two ids equals
 *      their generation order.
 *
 * The journal orders entries by id and cursored reads page by it, and neither
 * re-checks. A generator that only guarantees uniqueness — `uuidv4`, a
 * counter formatted without padding — corrupts both, silently. Check a
 * candidate with `assertIdGeneratorConformance` from `@agentick/utils/testing`.
 *
 * Call ONCE, at startup, before the first id is minted. This is a
 * construction-time choice, not a runtime toggle: two generators in one
 * process, or a swap against a store that already holds ids, breaks ordering
 * across the boundary exactly as a mismatched encoding would.
 */
export function setIdGenerator(generator: IdGenerator): void {
  generate = generator;
}

/** Restore the built-in generator. For tests that installed a double. */
export function resetIdGenerator(): void {
  generate = defaultGenerator;
}

/**
 * Generate a lexicographically-sortable id, monotonic within the process.
 * Delegates to whatever {@link setIdGenerator} installed.
 */
export function generateId(): string {
  return generate();
}

/**
 * The built-in generator. Monotonic within a single millisecond, and across
 * one via the time prefix.
 */
function defaultGenerator(): string {
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
