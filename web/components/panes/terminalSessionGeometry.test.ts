import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { createTerminalLayoutScheduler } from "./terminalLayoutScheduler";
import { syncTerminalGeometry } from "./terminalSessionGeometry";

describe("bound session geometry", () => {
  afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
  it.each([false, true])("fits a legal 18x4 split with only the scheduler driving the PTY (readonly=%s)", async (readOnly) => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    document.body.append(host);
    host.getBoundingClientRect = () => ({ width: 160, height: 70 } as DOMRect);
    const term = { cols: 80, rows: 24 } as Terminal;
    const resize = vi.fn();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term, getHost: () => host, getSessionId: () => "s1",
      getFitAddon: () => ({ proposeDimensions: () => ({ cols: 18, rows: 4 }),
        fit: () => Object.assign(term, { cols: 18, rows: 4 }) }) as unknown as FitAddon,
      isActive: () => true, canResizeBackend: () => !readOnly,
      repaint: vi.fn(), resizeBackend: resize, logger: vi.fn(),
    });
    syncTerminalGeometry("s1", term, { current: scheduler }, true, readOnly, "bind");
    await vi.advanceTimersByTimeAsync(100);
    expect([term.cols, term.rows]).toEqual([18, 4]);
    if (readOnly) expect(resize).not.toHaveBeenCalled();
    else { expect(resize).toHaveBeenCalledTimes(1); expect(resize).toHaveBeenCalledWith(18, 4); }
    expect(scheduler.hasPendingLayout()).toBe(false);
    scheduler.dispose();
  });
  it("does not let a stale binding override a newer geometry", () => {
    const flush = vi.fn();
    syncTerminalGeometry("old", {} as Terminal, { current: { flush } as unknown as ReturnType<typeof createTerminalLayoutScheduler> }, true, false, "old", () => false);
    expect(flush).not.toHaveBeenCalled();
  });
});

it("an explicit redraw restores current geometry and disposal cancels its remaining resize", async () => {
  vi.useFakeTimers();
  try {
    const term = { cols: 80, rows: 24 } as Terminal;
    const resize = vi.fn();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term, getHost: () => null, getFitAddon: () => null,
      getSessionId: () => "s1", isActive: () => true, canResizeBackend: () => true,
      repaint: vi.fn(), resizeBackend: resize, logger: vi.fn(),
    });
    scheduler.redrawBackend();
    expect(resize).toHaveBeenLastCalledWith(79, 24);
    Object.assign(term, { cols: 79, rows: 23 });
    await vi.advanceTimersByTimeAsync(80);
    expect(resize).toHaveBeenLastCalledWith(79, 23);
    scheduler.redrawBackend();
    const count = resize.mock.calls.length;
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(resize).toHaveBeenCalledTimes(count);
  } finally { vi.useRealTimers(); }
});
