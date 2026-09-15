import type { TerminalContainerSize, TerminalLayoutRequestOptions, TerminalLayoutScheduler } from "./terminalSessionGeometry";
export type { TerminalContainerSize, TerminalLayoutRequestOptions, TerminalLayoutScheduler } from "./terminalSessionGeometry";
import { isTerminalHostRenderable, isSanePtySize, requestTerminalRedraw } from "./terminalSessionGeometry";
export { isTerminalHostRenderable } from "./terminalSessionGeometry";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { deferTerminalLayoutDuringReplay } from "./terminalReplayPresentation";
import {
  bindTerminalCompositionRecovery,
  type AnimationFrameScheduler,
} from "./terminalCompositionRecovery";

type LayoutLogger = (event: string, payload?: Record<string, unknown>) => void;

interface CreateTerminalLayoutSchedulerOptions {
  getTerminal: () => Terminal | null;
  getFitAddon: () => FitAddon | null;
  getHost: () => HTMLElement | null;
  getSessionId: () => string | null;
  isActive: () => boolean;
  compositionFrameScheduler?: AnimationFrameScheduler;
  /** 共享 PTY 只允许主视图驱动后端尺寸；镜像视图仍可本地 fit。 */
  canResizeBackend?: () => boolean;
  repaint: (reason: string) => void;
  resizeBackend: (cols: number, rows: number) => void;
  logger: LayoutLogger;
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 0);
}

function cancelFrame(id: number): void {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(id);
    return;
  }
  window.clearTimeout(id);
}

function shouldFocusTerminal(): boolean {
  const active = document.activeElement;
  if (!active) return true;
  return active.tagName !== "INPUT" && active.tagName !== "TEXTAREA";
}

/** fit 后延迟校验容器与 cols/rows 是否仍一致（嵌套分屏可能有第二轮 reflow）。 */
const VERIFY_REFIT_DELAY_MS = 120;
const VERIFY_REFIT_REASON = "verify.refit";
/** verify 未收敛时的有限重试上限，防止持续 reflow 下无限自链。 */
const VERIFY_REFIT_MAX_ATTEMPTS = 3;
/** 创建时宿主常是 320×8，skip 后要等布局落地再 fit，不能把 8×1 留给 PTY。 */
const NOT_RENDERABLE_RETRY_MS = 200;
const NOT_RENDERABLE_RETRY_MAX = 8;
/** 后端 PTY resize 去抖窗口：拖拽期间 conpty 每次 resize 都整屏重绘，高频下发会留残行。 */
const BACKEND_RESIZE_DEBOUNCE_MS = 250;

function readProposedDimensions(
  fitAddon: FitAddon,
): { cols: number; rows: number } | null {
  if (typeof fitAddon.proposeDimensions !== "function") return null;
  try {
    const proposed = fitAddon.proposeDimensions();
    if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) return null;
    return { cols: proposed.cols, rows: proposed.rows };
  } catch {
    return null;
  }
}

function proposedSizeMatchesTerminal(term: Terminal, fitAddon: FitAddon): boolean {
  const proposed = readProposedDimensions(fitAddon);
  return proposed !== null && proposed.cols === term.cols && proposed.rows === term.rows;
}

export function createTerminalLayoutScheduler({
  getTerminal,
  getFitAddon,
  getHost,
  getSessionId,
  isActive,
  compositionFrameScheduler,
  canResizeBackend = () => true,
  repaint,
  resizeBackend,
  logger,
}: CreateTerminalLayoutSchedulerOptions): TerminalLayoutScheduler {
  let rafId: number | null = null;
  let nestedRafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let verifyTimerId: ReturnType<typeof setTimeout> | null = null;
  let backendTimerId: ReturnType<typeof setTimeout> | null = null;
  let lastBackendResizeAt = 0;
  let pendingBackendSize: { cols: number; rows: number } | null = null;
  let disposed = false;
  const replayLayoutOwner = {};
  let pendingReason: string | null = null;
  let pendingBackendSync = false;
  let pendingSyncAllowsInactive = false;
  let lastSize: { cols: number; rows: number } | null = null;
  let lastContainerSize: TerminalContainerSize | null = null;
  let verifyAttempts = 0;
  let notRenderableAttempts = 0;
  let imeLayoutBlocked = false;
  let notRenderableTimerId: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    if (nestedRafId !== null) {
      cancelFrame(nestedRafId);
      nestedRafId = null;
    }
  };

  // 只比较不推进基线：基线在 fit 成功后统一更新，避免"基线先走、fit 被跳过"
  // 之后小幅修正被永久吞掉的卡死。
  const shouldSkipContainerDelta = (options: TerminalLayoutRequestOptions): boolean => {
    if (options.force || !options.containerSize || !options.minContainerDelta) return false;
    if (!lastContainerSize) return false;

    const size = options.containerSize;
    const deltaWidth = Math.abs(size.width - lastContainerSize.width);
    const deltaHeight = Math.abs(size.height - lastContainerSize.height);
    if (
      deltaWidth < options.minContainerDelta &&
      deltaHeight < options.minContainerDelta
    ) {
      logger("layout.skip.container-jitter", {
        width: size.width,
        height: size.height,
        deltaWidth,
        deltaHeight,
      });
      return true;
    }

    return false;
  };

  const sendBackendResize = (cols: number, rows: number) => {
    if (disposed || !getSessionId()) return;
    lastBackendResizeAt = Date.now();
    pendingBackendSize = null;
    resizeBackend(cols, rows);
  };

  const scheduleBackendResize = (cols: number, rows: number) => {
    const elapsed = Date.now() - lastBackendResizeAt;
    if (backendTimerId === null && elapsed >= BACKEND_RESIZE_DEBOUNCE_MS) {
      sendBackendResize(cols, rows);
      return;
    }

    pendingBackendSize = { cols, rows };
    if (backendTimerId !== null) return;
    backendTimerId = setTimeout(() => {
      backendTimerId = null;
      const pending = pendingBackendSize;
      if (pending) {
        logger("layout.resize.trailing", pending);
        sendBackendResize(pending.cols, pending.rows);
      }
    }, BACKEND_RESIZE_DEBOUNCE_MS);
  };

  const applyLayout = (
    reason: string,
    options: TerminalLayoutRequestOptions = {},
  ): Terminal | null => {
    if (disposed) return null;
    // Preserve pending PTY synchronization through visibility and IME deferrals.
    if (pendingBackendSync) {
      options = {
        ...options,
        force: true,
        forceBackendSync: true,
        allowInactive: options.allowInactive || pendingSyncAllowsInactive,
      };
    }
    if (imeLayoutBlocked) {
      pendingReason = reason;
      logger("layout.skip.blocked", { reason });
      return null;
    }
    if (shouldSkipContainerDelta(options)) return null;

    const term = getTerminal();
    const fitAddon = getFitAddon();
    const host = getHost();
    if (!term || !fitAddon || !host) return null;
    if (deferTerminalLayoutDuringReplay(term, replayLayoutOwner, () =>
      flush("replay.complete", { force: true, allowInactive: true }))) {
      pendingReason = reason;
      return null;
    }

    if (!isActive() && !options.allowInactive) {
      pendingReason = reason;
      logger("layout.skip.inactive", { reason });
      return null;
    }

    const rect = host.getBoundingClientRect();
    if (!isTerminalHostRenderable(host)) {
      pendingReason = reason;
      logger("layout.skip.not-renderable", {
        reason,
        isConnected: host.isConnected,
        width: rect.width,
        height: rect.height,
      });
      scheduleNotRenderableRetry();
      return null;
    }

    const proposed = fitAddon.proposeDimensions?.();
    if (proposed && !isSanePtySize(proposed.cols, proposed.rows)) {
      pendingReason = reason;
      logger("layout.skip.degenerate", {
        reason,
        cols: proposed.cols,
        rows: proposed.rows,
        width: rect.width,
        height: rect.height,
      });
      return null;
    }

    // IME used to force fit + full `term.refresh` after every committed
    // candidate. When cols/rows did not change that hitch delayed the next
    // pinyin. Still fit when the host actually changed size, or when a PTY
    // sync is pending (`forceBackendSync` is merged in above).
    if (
      options.skipIfUnchanged &&
      !options.forceBackendSync &&
      proposedSizeMatchesTerminal(term, fitAddon)
    ) {
      lastContainerSize = { width: rect.width, height: rect.height };
      pendingReason = null;
      logger("layout.skip.unchanged", {
        reason,
        cols: term.cols,
        rows: term.rows,
      });
      return term;
    }

    // Capture before fit: xterm resize/WebGL recreate can blur the helper
    // textarea, and window.focus recovery does not pass focusIfSafe. Without
    // this, clicking the window fits then steals typing.
    const textarea = term.textarea;
    const restoreFocus =
      Boolean(options.focusIfSafe && shouldFocusTerminal()) ||
      Boolean(textarea && document.activeElement === textarea);

    try {
      fitAddon.fit();
    } catch (error) {
      logger("layout.fit.fail", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    repaint(reason);

    if (restoreFocus) {
      term.focus();
    }

    const { cols, rows } = term;
    if (!isSanePtySize(cols, rows)) {
      pendingReason = reason;
      logger("layout.skip.degenerate", {
        reason,
        cols,
        rows,
        width: rect.width,
        height: rect.height,
      });
      return null;
    }
    const sizeChanged = lastSize?.cols !== cols || lastSize?.rows !== rows;
    if (sizeChanged) {
      lastSize = { cols, rows };
    }
    if (getSessionId() && canResizeBackend() && (sizeChanged || options.forceBackendSync)) {
      if (options.forceBackendSync) {
        // Recovery must not be delayed or absorbed by the drag debounce.
        sendBackendResize(cols, rows);
      } else {
        scheduleBackendResize(cols, rows);
      }
    }

    // 无条件用实测 rect 推进基线：让 jitter 基线始终等于"上次实际 fit 的容器"，
    // 避免 forced flush 后基线陈旧、后续小幅修正被 minContainerDelta 吞掉。
    lastContainerSize = { width: rect.width, height: rect.height };

    pendingReason = null;
    pendingBackendSync = false;
    pendingSyncAllowsInactive = false;
    logger("layout.applied", {
      reason,
      cols,
      rows,
      width: rect.width,
      height: rect.height,
      sessionId: getSessionId(),
    });
    options.onAfterLayout?.(term);
    if (notRenderableTimerId !== null) {
      clearTimeout(notRenderableTimerId);
      notRenderableTimerId = null;
    }
    if (reason !== VERIFY_REFIT_REASON) {
      verifyAttempts = 0;
      notRenderableAttempts = 0;
      scheduleVerifyRefit();
    } else if (verifyAttempts < VERIFY_REFIT_MAX_ATTEMPTS) {
      // verify 补救后再复核一轮，未收敛可有限重试（多轮 reflow 场景）。
      scheduleVerifyRefit();
    }
    return term;
  };

  // fit 是事件驱动的单次执行；嵌套分屏在 fit 后可能还有一轮 reflow，
  // 之后 ResizeObserver 不再触发，终端会永久停在旧 cols/rows。
  // 延迟一拍复核 proposeDimensions，与实际不一致就强制补一次 fit（每轮最多一次）。
  const scheduleNotRenderableRetry = () => {
    if (notRenderableAttempts >= NOT_RENDERABLE_RETRY_MAX) return;
    if (notRenderableTimerId !== null) return;
    notRenderableTimerId = setTimeout(() => {
      notRenderableTimerId = null;
      if (disposed) return;
      if (!isTerminalHostRenderable(getHost())) {
        notRenderableAttempts += 1;
        if (notRenderableAttempts < NOT_RENDERABLE_RETRY_MAX) {
          scheduleNotRenderableRetry();
        }
        return;
      }
      notRenderableAttempts = 0;
      applyLayout(pendingReason ?? "layout.retry.renderable", {
        force: true,
        forceBackendSync: true,
        allowInactive: true,
      });
    }, NOT_RENDERABLE_RETRY_MS);
  };

  const scheduleVerifyRefit = () => {
    if (verifyTimerId !== null) {
      clearTimeout(verifyTimerId);
    }
    verifyTimerId = setTimeout(() => {
      verifyTimerId = null;
      if (disposed) return;
      const term = getTerminal();
      const fitAddon = getFitAddon();
      if (!term || !fitAddon || !isTerminalHostRenderable(getHost())) return;

      const proposed = readProposedDimensions(fitAddon);
      if (!proposed) return;
      if (proposed.cols === term.cols && proposed.rows === term.rows) return;

      logger("layout.verify.mismatch", {
        cols: term.cols,
        rows: term.rows,
        proposedCols: proposed.cols,
        proposedRows: proposed.rows,
        attempt: verifyAttempts + 1,
      });
      verifyAttempts += 1;
      // A successful inactive-pane fit was explicitly authorized by the caller.
      // Keep that permission for the post-reflow verification pass.
      applyLayout(VERIFY_REFIT_REASON, { force: true, allowInactive: true });
    }, VERIFY_REFIT_DELAY_MS);
  };

  const schedule = (
    reason: string,
    options: TerminalLayoutRequestOptions = {},
  ) => {
    if (disposed) return;
    pendingBackendSync ||= Boolean(options.forceBackendSync);
    pendingSyncAllowsInactive ||= Boolean(options.forceBackendSync && options.allowInactive);
    cancel();

    const run = () => {
      rafId = requestFrame(() => {
        nestedRafId = requestFrame(() => {
          rafId = null;
          nestedRafId = null;
          applyLayout(reason, options);
        });
      });
    };

    if (options.delayMs && options.delayMs > 0) {
      timerId = setTimeout(() => {
        timerId = null;
        run();
      }, options.delayMs);
      return;
    }

    run();
  };

  const flush = (
    reason: string,
    options: TerminalLayoutRequestOptions = {},
  ): Terminal | null => {
    pendingBackendSync ||= Boolean(options.forceBackendSync);
    pendingSyncAllowsInactive ||= Boolean(options.forceBackendSync && options.allowInactive);
    cancel();
    return applyLayout(reason, options);
  };

  const disposeCompositionRecovery = bindTerminalCompositionRecovery(
    getTerminal()?.textarea,
    (composing) => {
      imeLayoutBlocked = composing;
      if (composing) cancel();
    },
    () => {
      if (disposed) return;
      imeLayoutBlocked = false;
      // No deferred fit and no PTY sync: skip proposeDimensions too.
      // FitAddon.proposeDimensions() forces a layout reflow; doing that
      // after every 选字 hitchs the next pinyin even when size is unchanged.
      if (!pendingReason && !pendingBackendSync) return;
      flush("ime.compositionend", {
        force: true,
        allowInactive: true,
        skipIfUnchanged: true,
      });
    },
    compositionFrameScheduler,
  );

  let cancelRedraw = () => {};
  const redrawBackend = () => {
    if (disposed) return;
    cancelRedraw();
    if (backendTimerId !== null) clearTimeout(backendTimerId);
    backendTimerId = null;
    pendingBackendSize = null;
    cancelRedraw = requestTerminalRedraw(getTerminal, getSessionId, canResizeBackend, sendBackendResize);
  };

  return {
    schedule,
    flush,
    redrawBackend,
    cancel,
    dispose: () => {
      disposed = true;
      cancelRedraw();
      cancel();
      disposeCompositionRecovery();
      if (verifyTimerId !== null) {
        clearTimeout(verifyTimerId);
        verifyTimerId = null;
      }
      if (notRenderableTimerId !== null) {
        clearTimeout(notRenderableTimerId);
        notRenderableTimerId = null;
      }
      if (backendTimerId !== null) {
        clearTimeout(backendTimerId);
        backendTimerId = null;
      }
      pendingBackendSize = null;
      pendingReason = null;
      pendingBackendSync = false;
      pendingSyncAllowsInactive = false;
      lastContainerSize = null;
      lastSize = null;
    },
    hasPendingLayout: () => pendingReason !== null,
  };
}
