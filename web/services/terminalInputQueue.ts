import { debugTerminalService, splitInputRunsBySource, summarizeTerminalInput } from "./terminalServiceShared";
import type { TerminalInputQueue, TerminalWriteSource } from "./terminalServiceShared";

/** The sole input FIFO, including pending/in-flight accounting and cancellation. */
export function createTerminalInputQueue(
  writeTerminalInputNow: (sessionId: string, data: string, source: TerminalWriteSource) => Promise<void>,
) {
  const INPUT_BATCH_DELAY_MS = 8;
  const inputQueues = new Map<string, TerminalInputQueue>();
  const MAX_SESSION_INPUT_CHARS = 4 * 1024 * 1024;
  const MAX_GLOBAL_INPUT_CHARS = 8 * 1024 * 1024;
  
  function getTerminalInputQueueStats(): { sessions: number; retainedChars: number } {
    return { sessions: inputQueues.size, retainedChars: [...inputQueues.values()].reduce((sum, queue) => sum + queue.retainedChars, 0) };
  }

  function enqueueTerminalInput(
    sessionId: string, data: string, source: TerminalWriteSource, traceId?: number, flushImmediately = false,
  ): Promise<void> {
    if (data.length === 0) return Promise.resolve();
    let queue = inputQueues.get(sessionId);
    if ((queue?.retainedChars ?? 0) + data.length > MAX_SESSION_INPUT_CHARS
        || getTerminalInputQueueStats().retainedChars + data.length > MAX_GLOBAL_INPUT_CHARS) {
      return Promise.reject(new Error("Terminal input queue is full"));
    }
    if (!queue) {
      queue = { retainedChars: 0, pending: [], timer: null, flushing: false, idleResolvers: [] };
      inputQueues.set(sessionId, queue);
    }
    const result = new Promise<void>((resolve, reject) => {
      queue.pending.push({ data, source, traceId, resolve, reject });
      queue.retainedChars += data.length;
    });
    // Flush idle keys immediately; the in-flight write still serializes and coalesces input.
    flushImmediately ||= source === "user-keyboard";
    if (flushImmediately && queue.timer !== null) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
    if (queue.timer === null && !queue.flushing) {
      if (flushImmediately) void flushTerminalInputQueue(sessionId);
      else queue.timer = setTimeout(() => void flushTerminalInputQueue(sessionId), INPUT_BATCH_DELAY_MS);
    }
    return result;
  }
  
  async function flushTerminalInputQueue(sessionId: string): Promise<void> {
    const queue = inputQueues.get(sessionId);
    if (!queue) return;
    if (queue.flushing) return;
    queue.timer = null;
    if (queue.pending.length === 0) return;
  
    const batch = queue.pending.splice(0);
    const retainedChars = batch.reduce((sum, item) => sum + item.data.length, 0);
    const traceIds = batch.map((item) => item.traceId ?? null);
    queue.flushing = true;
    debugTerminalService("input.queue.flush.begin", {
      sessionId,
      traceIds,
      chunkCount: batch.length,
      retainedChars,
    });
    try {
      for (const run of splitInputRunsBySource(batch)) {
        if (inputQueues.get(sessionId) !== queue) throw new DOMException("Terminal input cancelled", "AbortError");
        await writeTerminalInputNow(sessionId, run.items.map((i) => i.data).join(""), run.source);
        for (const item of run.items) item.resolve();
      }
      debugTerminalService("input.queue.flush.ok", {
        sessionId,
        traceIds,
        retainedChars,
      });
    } catch (error) {
      debugTerminalService("input.queue.flush.error", {
        sessionId,
        traceIds,
        error: error instanceof Error ? error.message : String(error),
        retainedChars,
      });
      for (const item of batch) item.reject(error);
    } finally {
      queue.retainedChars -= retainedChars;
      const current = inputQueues.get(sessionId);
      if (current !== queue) return;
      queue.flushing = false;
      if (queue.pending.length > 0) {
        void flushTerminalInputQueue(sessionId);
      } else {
        const resolvers = queue.idleResolvers.splice(0);
        for (const resolve of resolvers) resolve();
        inputQueues.delete(sessionId);
      }
    }
  }
  
  function drainTerminalInputQueue(sessionId: string): Promise<void> {
    const queue = inputQueues.get(sessionId);
    if (!queue) return Promise.resolve();
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = null;
      void flushTerminalInputQueue(sessionId);
    }
    if (!queue.flushing && queue.pending.length === 0) {
      inputQueues.delete(sessionId);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.idleResolvers.push(resolve);
    });
  }
  
  function clearTerminalInputQueue(sessionId: string): void {
    const queue = inputQueues.get(sessionId);
    if (!queue) return;
    if (queue.timer) {
      clearTimeout(queue.timer);
    }
    for (const item of queue.pending.splice(0)) {
      debugTerminalService("input.queue.clear", {
        sessionId,
        traceId: item.traceId ?? null,
        data: summarizeTerminalInput(item.data),
      });
      item.reject(new DOMException("Terminal input cancelled", "AbortError"));
    }
    for (const resolve of queue.idleResolvers.splice(0)) resolve();
    inputQueues.delete(sessionId);
  }
  
  return {
    enqueueTerminalInput, drainTerminalInputQueue, clearTerminalInputQueue, getTerminalInputQueueStats,
    clearAll: () => { for (const sessionId of [...inputQueues.keys()]) clearTerminalInputQueue(sessionId); },
  };
}
