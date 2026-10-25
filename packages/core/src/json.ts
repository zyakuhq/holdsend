/**
 * What can be kept in an outbox: plain JSON. Anything else (a Map, a Set, a
 * Date, a Blob or File, a class instance, a function, NaN, a cycle) would be
 * changed or silently dropped on the way to storage, and the person's work
 * with it. So it is refused when added, with the path to the bad value.
 *
 * Files and photos: store them yourself (IndexedDB, the file system) and put
 * a reference to them in the payload.
 */

export class NotJsonError extends TypeError {
  constructor(readonly path: string, what: string) {
    super(`outbox payloads must be plain JSON: ${path} is ${what}`);
    this.name = "NotJsonError";
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return String(value);
  if (typeof value !== "object" || value === null) return `a ${typeof value}`;
  const name = Object.getPrototypeOf(value)?.constructor?.name;
  return name ? `a ${name}` : "an object without a prototype";
}

/** Throws NotJsonError unless `value` is plain JSON (objects, arrays, strings, finite numbers, booleans, null). */
export function assertPlainJson(value: unknown, path = "payload"): void {
  const seen = new Set<object>();
  const visit = (v: unknown, at: string): void => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new NotJsonError(at, describe(v));
      return;
    }
    if (typeof v !== "object") throw new NotJsonError(at, describe(v));
    if (seen.has(v)) throw new NotJsonError(at, "a reference back to itself");
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        if (!(i in v)) throw new NotJsonError(`${at}[${i}]`, "a hole in an array");
        visit(v[i], `${at}[${i}]`);
      }
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new NotJsonError(at, describe(v));
      for (const k of Object.keys(v)) {
        const child = (v as Record<string, unknown>)[k];
        // An undefined property is simply absent in JSON, which is what the author meant.
        if (child !== undefined) visit(child, `${at}.${k}`);
      }
    }
    seen.delete(v);
  };
  visit(value, path);
}
