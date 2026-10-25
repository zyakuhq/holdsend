/**
 * Idempotency keys.
 *
 * A key only has to be unique per owner and operation, because the server
 * scopes every key to the person who sent it. It is not a secret. We still
 * prefer the platform's cryptographic generator, because it is the cheapest
 * way to get uniqueness without coordination.
 */

/** 8 to 128 characters of letters, digits, "_", "-", ":" or ".". */
export const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export function isValidKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
}

function platformCrypto(): CryptoLike | undefined {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  return c && typeof c === "object" ? c : undefined;
}

/**
 * A new random key (a UUID v4 where the platform can make one).
 *
 * Without any platform crypto (some React Native setups without a polyfill)
 * it falls back to time plus Math.random. That is unique enough for an
 * idempotency key, which is scoped per owner on the server, but apps that can
 * should install a crypto polyfill or pass their own `newKey`.
 */
export function newKey(): string {
  const c = platformCrypto();
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      /* fall through */
    }
  }
  if (c?.getRandomValues) {
    try {
      const bytes = c.getRandomValues(new Uint8Array(16));
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch {
      /* fall through */
    }
  }
  const random = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `hs-${Date.now().toString(36)}-${random()}${random()}`;
}
