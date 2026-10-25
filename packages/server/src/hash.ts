/**
 * Request fingerprints. Two requests are "the same request" when the
 * fingerprints of their content match.
 *
 * The content is first put in canonical form (object keys sorted at every
 * level), then serialised with the platform's JSON.stringify, then hashed
 * with SHA-256 through Web Crypto, so this runs on Node 20+, Deno, Bun and
 * edge runtimes.
 *
 * Only plain JSON is accepted. A Map, Set, Date or class instance would
 * otherwise serialise as "{}" (or a string), and two different requests could
 * share a fingerprint and be answered with each other's result.
 */
import { assertPlainJson } from "@holdsend/core";

function sortedCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedCopy);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      // defineProperty keeps a key named "__proto__" as plain data.
      Object.defineProperty(out, key, { value: sortedCopy(child), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/**
 * Canonical JSON text: keys sorted at every level, absent (undefined)
 * properties dropped. Throws NotJsonError for anything that is not plain JSON.
 */
export function canonicalJson(content: unknown): string {
  assertPlainJson(content, "content");
  return JSON.stringify(sortedCopy(content));
}

interface DigestApi {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

function webCrypto(): DigestApi {
  const subtle = (globalThis as { crypto?: { subtle?: DigestApi } }).crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto (crypto.subtle) is required to fingerprint requests");
  return subtle;
}

function utf8(text: string): Uint8Array {
  const Encoder = (globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } }).TextEncoder;
  return new Encoder().encode(text);
}

function toHex(buffer: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) hex += (byte < 16 ? "0" : "") + byte.toString(16);
  return hex;
}

/** SHA-256 (hex) of the operation name and the canonical content. */
export async function hashRequest(operation: string, content: unknown): Promise<string> {
  const digest = await webCrypto().digest("SHA-256", utf8(`${operation.length}:${operation}|${canonicalJson(content)}`));
  return toHex(digest);
}
