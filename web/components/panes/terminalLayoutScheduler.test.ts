import { afterEach, describe, expect, it, vi } from "vitest";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  createTerminalLayoutScheduler,
  isTerminalHostRenderable,
} from "./terminalLayoutScheduler";

function createRenderableHost(width = 640, height = 360): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
  return host;
}

function createCompositionFrameScheduler() {
  let nextFrameHandle = 1;
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  return {
    compositionFrameScheduler: {
      request: vi.fn((callback: FrameRequestCallback) => {
        const handle = nextFrameHandle++;
        frameCallbacks.set(handle, callback);
        return handle;
      }),
      cancel: vi.fn((handle: number) => frameCallbacks.delete(handle)),
    },
    flushFrame: () => {
      const callbacks = [...frameCallbacks.values()];
      frameCallbacks.clear();
      callbacks.forEach((callback) => callback(0));
    },
  };
}

describe("terminal layout scheduler", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("detects hidden or zero-sized terminal hosts", () => {
    expect(isTerminalHostRenderable(null)).toBe(false);

    const host = createRenderableHost();
    expect(isTerminalHostRenderable(host)).toBe(true);

    host.style.display = "none";
    expect(isTerminalHostRenderable(host)).toBe(false);
  });

  it("rejects a host with no measurable height", () => {
    const host = createRenderableHost(88, 0);
    expect(isTerminalHostRenderable(host)).toBe(false);
  });

  it("does not resize the PTY when Fit proposes a degenerate size", () => {
    const host = createRenderableHost(640, 360);
    const term = { cols: 80, rows: 24 } as Terminal;
    const fitAddon = {
      proposeDimensions: vi.fn(() => ({ cols: 1, rows: 0 })),
      fit: vi.fn(),
    } as unknown as FitAddon;
    const resizeBackend = vi.fn();
    const logger = vi.fn();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "s1",
      isActive: () => true,
      repaint: vi.fn(),
      resizeBackend,
      logger,
    });
    expect(scheduler.flush("resize-observer.fit")).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(resizeBackend).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(
      "layout.skip.degenerate",
      expect.objectContaining({ cols: 1, rows: 0 }),
    );
    scheduler.dispose();
  });

  it("refocuses the terminal when fit blurs the helper textarea", () => {
    const host = createRenderableHost();
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const term = {
      cols: 80,
      rows: 24,
      textarea,
      focus: vi.fn(() => textarea.focus()),
    } as unknown as Terminal;
    const fitAddon = {
      fit: vi.fn(() => {
        textarea.blur();
      }),
    } as unknown as FitAddon;
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    scheduler.flush("window.focus", { force: true, forceBackendSync: true });
    expect(term.focus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(textarea);
    scheduler.dispose();
    textarea.remove();
  });

  it("does not steal focus from another input during window-focus recovery", () => {
    const host = createRenderableHost();
    const other = document.createElement("input");
    document.body.appendChild(other);
    const term = {
      cols: 80,
      rows: 24,
      textarea: document.createElement("textarea"),
      focus: vi.fn(),
    } as unknown as Terminal;
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => ({ fit: vi.fn() }) as unknown as FitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    other.focus();
    scheduler.flush("window.focus", { force: true, forceBackendSync: true });
    expect(term.focus).not.toHaveBeenCalled();
    scheduler.dispose();
    other.remove();
  });

  it("fits, repaints, and resizes the backend when visible", () => {
    const host = createRenderableHost();
    const term = {
      cols: 80,
      rows: 24,
      focus: vi.fn(),
    } as unknown as Terminal;
    const fitAddon = {
      fit: vi.fn(() => {
        (term as unknown as { cols: number; rows: number }).cols = 100;
        (term as unknown as { cols: number; rows: number }).rows = 30;
      }),
    } as unknown as FitAddon;
    const repaint = vi.fn();
    const resizeBackend = vi.fn();

    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      repaint,
      resizeBackend,
      logger: vi.fn(),
    });

    expect(scheduler.flush("test", { focusIfSafe: true })).toBe(term);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(repaint).toHaveBeenCalledWith("test");
    expect(resizeBackend).toHaveBeenCalledWith(100, 30);
    expect(term.focus).toHaveBeenCalledOnce();
  });

  it("re-sends the current geometry for an explicit Fit even when xterm is unchanged", () => {
    const host = createRenderableHost();
    const term = { cols: 80, rows: 24 } as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    const resizeBackend = vi.fn();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      repaint: vi.fn(),
      resizeBackend,
      logger: vi.fn(),
    });

    scheduler.flush("initial");
    resizeBackend.mockClear();

    scheduler.flush("context-menu.fit", {
      force: true,
      forceBackendSync: true,
    });

    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(resizeBackend).toHaveBeenCalledTimes(1);
    expect(resizeBackend).toHaveBeenCalledWith(80, 24);
    scheduler.dispose();
  });

  it("defers layout when inactive", () => {
    const host = createRenderableHost();
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;

    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => ({ cols: 80, rows: 24 } as Terminal),
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => false,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    expect(scheduler.flush("inactive")).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(true);
    scheduler.dispose();
  });

  it("keeps zero-sized hosts dirty and fits once the host becomes visible", () => {
    const host = createRenderableHost(0, 0);
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    let width = 0;
    let height = 0;
    Object.defineProperty(host, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => {},
      }),
    });
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => ({ cols: 80, rows: 24 } as Terminal),
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => false,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    expect(scheduler.flush("hidden", { allowInactive: true })).toBeNull();
    expect(scheduler.hasPendingLayout()).toBe(true);
    expect(fitAddon.fit).not.toHaveBeenCalled();

    width = 640;
    height = 360;
    scheduler.flush("visible", { allowInactive: true });
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(scheduler.hasPendingLayout()).toBe(false);
    scheduler.dispose();
  });

  it("does not resize while the document is hidden", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const host = createRenderableHost(1, 1);
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => ({ cols: 80, rows: 24 } as Terminal),
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    expect(scheduler.flush("minimized")).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(true);
    scheduler.dispose();
  });

  it("retries fit after a collapsed host becomes renderable", () => {
    vi.useFakeTimers();
    const host = createRenderableHost(88, 0);
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    let width = 88;
    let height = 0;
    Object.defineProperty(host, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => {},
      }),
    });
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => ({ cols: 80, rows: 24 } as Terminal),
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    expect(scheduler.flush("session.create.fit", { allowInactive: true })).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();

    width = 1112;
    height = 1254;
    vi.advanceTimersByTime(200);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    scheduler.dispose();
    vi.useRealTimers();
  });

  it("blocks layout during IME and skips recovery fit when cols/rows are unchanged", () => {
    vi.useFakeTimers();
    const host = createRenderableHost();
    const fitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    } as unknown as FitAddon;
    const textarea = document.createElement("textarea");
    const term = { cols: 80, rows: 24, textarea } as unknown as Terminal;
    const { compositionFrameScheduler, flushFrame } = createCompositionFrameScheduler();
    const repaint = vi.fn();
    const logger = vi.fn();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      compositionFrameScheduler,
      repaint,
      resizeBackend: vi.fn(),
      logger,
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(scheduler.flush("composition.resize", { force: true })).toBeNull();
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(true);

    textarea.dispatchEvent(new FocusEvent("blur"));
    flushFrame();
    flushFrame();

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(false);
    expect(logger).toHaveBeenCalledWith(
      "layout.skip.unchanged",
      expect.objectContaining({ reason: "ime.compositionend", cols: 80, rows: 24 }),
    );
    scheduler.dispose();
  });

  it("does not probe dimensions after IME when no layout was deferred", () => {
    vi.useFakeTimers();
    const host = createRenderableHost();
    const proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    const fitAddon = {
      fit: vi.fn(),
      proposeDimensions,
    } as unknown as FitAddon;
    const textarea = document.createElement("textarea");
    const term = { cols: 80, rows: 24, textarea } as unknown as Terminal;
    const { compositionFrameScheduler, flushFrame } = createCompositionFrameScheduler();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      compositionFrameScheduler,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    textarea.dispatchEvent(new FocusEvent("blur"));
    flushFrame();
    flushFrame();

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(proposeDimensions).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("still fits after IME recovery when proposed dimensions differ", () => {
    vi.useFakeTimers();
    const host = createRenderableHost();
    const textarea = document.createElement("textarea");
    const term = { cols: 80, rows: 24, textarea } as unknown as Terminal;
    const fitAddon = {
      fit: vi.fn(() => {
        (term as unknown as { cols: number; rows: number }).cols = 100;
        (term as unknown as { cols: number; rows: number }).rows = 30;
      }),
      proposeDimensions: vi.fn(() => ({ cols: 100, rows: 30 })),
    } as unknown as FitAddon;
    const { compositionFrameScheduler, flushFrame } = createCompositionFrameScheduler();
    const repaint = vi.fn();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      compositionFrameScheduler,
      repaint,
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(scheduler.flush("composition.resize", { force: true })).toBeNull();
    textarea.dispatchEvent(new FocusEvent("blur"));
    flushFrame();
    flushFrame();

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(repaint).toHaveBeenCalledWith("ime.compositionend");
    expect(scheduler.hasPendingLayout()).toBe(false);
    scheduler.dispose();
  });

  it("still fits IME recovery when a backend sync is pending even if size is unchanged", () => {
    vi.useFakeTimers();
    const host = createRenderableHost();
    const textarea = document.createElement("textarea");
    const term = { cols: 80, rows: 24, textarea } as unknown as Terminal;
    const fitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    } as unknown as FitAddon;
    const { compositionFrameScheduler, flushFrame } = createCompositionFrameScheduler();
    const resizeBackend = vi.fn();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      compositionFrameScheduler,
      repaint: vi.fn(),
      resizeBackend,
      logger: vi.fn(),
    });

    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(scheduler.flush("recovery.fit", { force: true, forceBackendSync: true })).toBeNull();
    textarea.dispatchEvent(new FocusEvent("blur"));
    flushFrame();
    flushFrame();

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(resizeBackend).toHaveBeenCalledWith(80, 24);
    scheduler.dispose();
  });

  it("can layout a visible inactive pane when explicitly allowed", () => {
    const host = createRenderableHost();
    const term = { cols: 80, rows: 24, focus: vi.fn() } as unknown as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    const onAfterLayout = vi.fn();

    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => false,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    expect(scheduler.flush("inactive-visible", {
      allowInactive: true,
      onAfterLayout,
    })).toBe(term);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(onAfterLayout).toHaveBeenCalledWith(term);
    expect(term.focus).not.toHaveBeenCalled();
    expect(scheduler.hasPendingLayout()).toBe(false);
  });

  it("can force a layout even when the container delta is below the jitter threshold", () => {
    const host = createRenderableHost();
    const term = { cols: 80, rows: 24 } as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => true,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    scheduler.flush("first", {
      containerSize: { width: 640, height: 360 },
      minContainerDelta: 5,
    });
    scheduler.flush("jitter", {
      containerSize: { width: 642, height: 362 },
      minContainerDelta: 5,
    });
    scheduler.flush("forced", {
      force: true,
      containerSize: { width: 643, height: 363 },
      minContainerDelta: 5,
    });

    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
  });

  it("does not advance the jitter baseline when the fit is skipped", () => {
    const host = createRenderableHost();
    const term = { cols: 80, rows: 24 } as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    let active = true;
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "session-1",
      isActive: () => active,
      repaint: vi.fn(),
      resizeBackend: vi.fn(),
      logger: vi.fn(),
    });

    scheduler.flush("first", {
      containerSize: { width: 640, height: 360 },
      minContainerDelta: 5,
    });
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);

    // 尺寸大幅变化但 pane 不活跃：fit 被跳过，基线必须停在 640。
    active = false;
    scheduler.flush("inactive-resize", {
      containerSize: { width: 700, height: 360 },
      minContainerDelta: 5,
    });
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);

    // 激活后同尺寸再来一次：相对旧基线 delta=60，不能被抖动阈值吞掉。
    active = true;
    scheduler.flush("active-resize", {
      containerSize: { width: 700, height: 360 },
      minContainerDelta: 5,
    });
    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
  });

  it("refits once when the verify pass finds a dimension mismatch", () => {
    vi.useFakeTimers();
    try {
      const host = createRenderableHost();
      const term = { cols: 80, rows: 24 } as Terminal;
      let proposed = { cols: 100, rows: 30 };
      const fitAddon = {
        fit: vi.fn(() => {
          (term as unknown as { cols: number; rows: number }).cols = proposed.cols;
          (term as unknown as { cols: number; rows: number }).rows = proposed.rows;
        }),
        proposeDimensions: vi.fn(() => proposed),
      } as unknown as FitAddon;
      const scheduler = createTerminalLayoutScheduler({
        getTerminal: () => term,
        getFitAddon: () => fitAddon,
        getHost: () => host,
        getSessionId: () => "session-1",
        isActive: () => true,
        repaint: vi.fn(),
        resizeBackend: vi.fn(),
        logger: vi.fn(),
      });

      scheduler.flush("initial");
      expect(fitAddon.fit).toHaveBeenCalledTimes(1);

      // fit 之后布局又变了一轮（模拟嵌套分屏二次 reflow）。
      proposed = { cols: 90, rows: 28 };
      vi.advanceTimersByTime(200);
      expect(fitAddon.fit).toHaveBeenCalledTimes(2);
      expect(term.cols).toBe(90);

      // verify 补救后尺寸一致，不再无限重复。
      vi.advanceTimersByTime(500);
      expect(fitAddon.fit).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps inactive-pane permission for the verify refit", () => {
    vi.useFakeTimers();
    try {
      const host = createRenderableHost();
      const term = { cols: 80, rows: 24 } as Terminal;
      let proposed = { cols: 100, rows: 30 };
      const fitAddon = {
        fit: vi.fn(() => {
          (term as unknown as { cols: number; rows: number }).cols = proposed.cols;
          (term as unknown as { cols: number; rows: number }).rows = proposed.rows;
        }),
        proposeDimensions: vi.fn(() => proposed),
      } as unknown as FitAddon;
      const scheduler = createTerminalLayoutScheduler({
        getTerminal: () => term,
        getFitAddon: () => fitAddon,
        getHost: () => host,
        getSessionId: () => "session-1",
        isActive: () => false,
        repaint: vi.fn(),
        resizeBackend: vi.fn(),
        logger: vi.fn(),
      });

      scheduler.flush("inactive-pane", { allowInactive: true });
      proposed = { cols: 90, rows: 28 };
      vi.advanceTimersByTime(200);

      expect(fitAddon.fit).toHaveBeenCalledTimes(2);
      expect(term.cols).toBe(90);
      expect(term.rows).toBe(28);
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces rapid backend resizes to leading and trailing sends", () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    try {
      const host = createRenderableHost();
      const term = { cols: 80, rows: 24 } as Terminal;
      const setDims = (cols: number, rows: number) => {
        (term as unknown as { cols: number; rows: number }).cols = cols;
        (term as unknown as { cols: number; rows: number }).rows = rows;
      };
      const fitAddon = {
        fit: vi.fn(),
        proposeDimensions: vi.fn(() => ({ cols: term.cols, rows: term.rows })),
      } as unknown as FitAddon;
      const resizeBackend = vi.fn();
      const scheduler = createTerminalLayoutScheduler({
        getTerminal: () => term,
        getFitAddon: () => fitAddon,
        getHost: () => host,
        getSessionId: () => "session-1",
        isActive: () => true,
        repaint: vi.fn(),
        resizeBackend,
        logger: vi.fn(),
      });

      // leading：距上次足够久，立即下发。
      scheduler.flush("drag-1");
      expect(resizeBackend).toHaveBeenCalledWith(80, 24);
      expect(resizeBackend).toHaveBeenCalledTimes(1);

      // 拖拽期间连续变化：不立即下发，只记最新值。
      setDims(90, 26);
      vi.advanceTimersByTime(50);
      scheduler.flush("drag-2");
      setDims(100, 30);
      vi.advanceTimersByTime(50);
      scheduler.flush("drag-3");
      expect(resizeBackend).toHaveBeenCalledTimes(1);

      // trailing：只发最终尺寸。
      vi.advanceTimersByTime(300);
      expect(resizeBackend).toHaveBeenCalledTimes(2);
      expect(resizeBackend).toHaveBeenLastCalledWith(100, 30);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fits a mirror view without resizing the shared backend PTY", () => {
    const host = createRenderableHost();
    const term = { cols: 100, rows: 30 } as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    const resizeBackend = vi.fn();
    const scheduler = createTerminalLayoutScheduler({
      getTerminal: () => term,
      getFitAddon: () => fitAddon,
      getHost: () => host,
      getSessionId: () => "shared-session",
      isActive: () => true,
      canResizeBackend: () => false,
      repaint: vi.fn(),
      resizeBackend,
      logger: vi.fn(),
    });

    expect(scheduler.flush("mirror.fit")).toBe(term);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(resizeBackend).not.toHaveBeenCalled();
  });
});
