/**
 * Request hashing. Two requests are "the same request" when their content
 * hashes match. Hash only the content: anything a client sends that is not
 * the content (transport ids, timestamps) must be left out by the caller.
 *
 * Uses Web Crypto, so it runs on Node 20+, Deno, Bun and edge runtimes.
 */

/** Deterministic JSON: object keys sorted, undefined dropped. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined || typeof v === "function" ? "null" : stableStringify(v))).join(",")}]`;
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return stableStringify((value as { toJSON: () => unknown }).toJSON());
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((k) => record[k] !== undefined && typeof record[k] !== "function")
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${entries.join(",")}}`;
}

interface SubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

function subtle(): SubtleLike {
  const c = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto;
  if (!c?.subtle) throw new Error("Web Crypto (crypto.subtle) is required to hash requests");
  return c.subtle;
}

/** SHA-256 hex of the operation name and the content. */
export async function hashRequest(operation: string, content: unknown): Promise<string> {
  const text = `${operation}\n${stableStringify(content)}`;
  const Encoder = (globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } }).TextEncoder;
  const digest = await subtle().digest("SHA-256", new Encoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
