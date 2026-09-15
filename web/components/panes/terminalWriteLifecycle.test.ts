import { describe, expect, it, vi } from "vitest";
import { createTerminalWriteFlowControl } from "./terminalWriteFlowControl";

describe("terminal write lifetime", () => {
  it("settles in-flight writes on disposal and ignores their late tails", async () => {
    vi.useFakeTimers();
    try {
      const callbacks: Array<() => void> = [];
      const target = { write: vi.fn((_data: string, callback?: () => void) => callbacks.push(callback!)) };
      const flow = createTerminalWriteFlowControl(target);
      let result = "pending";
      const done = flow.write("x".repeat(20_000)).then(() => { result = "ok"; }, () => { result = "cancelled"; });
      flow.dispose();
      await Promise.resolve();
      expect(result).toBe("cancelled");
      callbacks[0]();
      await vi.runAllTimersAsync();
      expect(target.write).toHaveBeenCalledTimes(1);
      await expect(flow.write("after dispose")).rejects.toThrow();
      expect(flow.getStats()).toMatchObject({ queuedChars: 0, inFlightChars: 0, inFlightWrites: 0 });
      await done;
    } finally { vi.useRealTimers(); }
  });

  it("keeps a large write's tail ahead of subsequently queued output", async () => {
    vi.useFakeTimers();
    try {
      const callbacks: Array<() => void> = [];
      const chunks: string[] = [];
      const flow = createTerminalWriteFlowControl({ write: (data, callback) => { chunks.push(data); callbacks.push(callback!); } });
      const first = flow.write("x".repeat(16_384) + "TAIL");
      const next = flow.write("NEW");
      callbacks.shift()!();
      await vi.advanceTimersByTimeAsync(20);
      while (callbacks.length) callbacks.shift()!();
      await Promise.all([first, next]);
      expect(chunks.join("")).toBe("x".repeat(16_384) + "TAILNEW");
    } finally { vi.useRealTimers(); }
  });
});
