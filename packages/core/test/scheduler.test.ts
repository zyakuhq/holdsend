import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlushScheduler, type FlushReport } from "../src/index.js";

const report = (r: Partial<FlushReport> = {}): FlushReport => ({ sent: 0, retry: 0, busy: 0, stuck: 0, ...r });

describe("createFlushScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off while work remains, and stops scheduling once it is done", async () => {
    vi.useFakeTimers();
    const results: (FlushReport | "skipped")[] = [report({ retry: 1 }), "skipped", report({ busy: 1 }), report({ sent: 1 })];
    const calls: number[] = [];
    const s = createFlushScheduler({
      flush: async () => {
        calls.push(Date.now());
        return results.shift() ?? report();
      },
      backoffMs: [100, 200, 400],
    });
    s.kick();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls.map((t) => t - calls[0]!)).toEqual([0, 100, 300, 700]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(4);
    s.stop();
  });

  it("folds kicks during a pass into exactly one more pass", async () => {
    let release!: () => void;
    let passes = 0;
    const s = createFlushScheduler({
      flush: async () => {
        passes += 1;
        if (passes === 1) await new Promise<void>((r) => (release = r));
        return report();
      },
    });
    s.kick();
    s.kick();
    s.kick();
    await Promise.resolve();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(passes).toBe(2);
    s.stop();
  });

  it("does nothing while offline, and retries after an error", async () => {
    vi.useFakeTimers();
    let online = false;
    let calls = 0;
    const errors: unknown[] = [];
    const s = createFlushScheduler({
      isOnline: () => online,
      flush: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return report();
      },
      backoffMs: [50],
      onError: (e) => errors.push(e),
    });
    s.kick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(0);
    online = true;
    s.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(2);
    s.stop();
  });
});
