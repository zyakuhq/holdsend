/**
 * A tiny in-memory server that follows the HoldSend wire contract, for tests.
 * Synthetic data only.
 */
import { classifyResponse, ERROR_IN_PROGRESS, ERROR_KEY_CONFLICT, type AttemptOutcome } from "../src/index.js";

export interface StoredRecord {
  key: string;
  body: string;
  writtenAt: string | undefined;
}

export class FakeServer {
  /** Every resource actually created. Exactly-once means one per key. */
  readonly created: StoredRecord[] = [];
  /** Every request that reached the server, including replays. */
  requests = 0;
  private readonly byKey = new Map<string, StoredRecord>();
  private readonly inProgress = new Set<string>();

  /** Handles one request and returns the HTTP status and error code. */
  handle(headers: Record<string, string>, body: unknown): { status: number; code?: string } {
    this.requests += 1;
    const key = headers["Idempotency-Key"];
    if (!key) return { status: 400, code: "missing_key" };
    const text = JSON.stringify(body);
    if (this.inProgress.has(key)) return { status: 409, code: ERROR_IN_PROGRESS };
    const existing = this.byKey.get(key);
    if (existing) {
      if (existing.body !== text) return { status: 409, code: ERROR_KEY_CONFLICT };
      return { status: 200 };
    }
    const record: StoredRecord = { key, body: text, writtenAt: headers["Written-At"] };
    this.byKey.set(key, record);
    this.created.push(record);
    return { status: 201 };
  }

  /** Marks a key as being processed by an earlier, still running attempt. */
  holdInProgress(key: string): void {
    this.inProgress.add(key);
  }

  release(key: string): void {
    this.inProgress.delete(key);
  }

  /** A sender for the Outbox that talks to this server. */
  sender(options: { loseResponses?: number } = {}) {
    let toLose = options.loseResponses ?? 0;
    return async (item: { payload: unknown }, context: { headers: Record<string, string> }): Promise<AttemptOutcome> => {
      const answer = this.handle(context.headers, item.payload);
      if (toLose > 0) {
        toLose -= 1;
        // The server did the work, but the answer never came back.
        throw new Error("Network request failed");
      }
      return classifyResponse(answer.status, answer.code);
    };
  }
}
