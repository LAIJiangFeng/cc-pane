import type { Terminal } from "@xterm/xterm";

export interface TerminalContainerSize {
  width: number;
  height: number;
}

export interface TerminalLayoutRequestOptions {
  focusIfSafe?: boolean;
  delayMs?: number;
  containerSize?: TerminalContainerSize;
  minContainerDelta?: number;
  force?: boolean;
  /** Synchronize even unchanged dimensions, bypassing drag debounce. */
  forceBackendSync?: boolean;
  allowInactive?: boolean;
  /** Skip redundant IME fits unless dimensions changed or a sync is pending. */
  skipIfUnchanged?: boolean;
  onAfterLayout?: (term: Terminal) => void;
}

export interface TerminalLayoutScheduler {
  schedule: (reason: string, options?: TerminalLayoutRequestOptions) => void;
  flush: (reason: string, options?: TerminalLayoutRequestOptions) => Terminal | null;
  cancel: () => void;
  dispose: () => void;
  hasPendingLayout: () => boolean;
  /** Explicit user request only; automatic recovery never nudges the PTY. */
  redrawBackend: () => void;
}

/** The scheduler owns measurement, retries, and the sole backend resize. */
export function syncTerminalGeometry(
  _sessionId: string,
  _term: Terminal,
  layoutSchedulerRef: { current: TerminalLayoutScheduler | null },
  _drivesBackendPty: boolean,
  _readOnly: boolean,
  reason: string,
  shouldResizeBackend: () => boolean = () => true,
): void {
  if (!shouldResizeBackend()) return;
  layoutSchedulerRef.current?.flush(`${reason}.fit`, {
    force: true,
    forceBackendSync: true,
    allowInactive: true,
  });
}

export function isTerminalHostRenderable(host: HTMLElement | null): boolean {
  if (!host || !host.isConnected || document.visibilityState === "hidden") return false;

  const style = window.getComputedStyle(host);
  if (style.display === "none" || style.visibility === "hidden") return false;

  const rect = host.getBoundingClientRect();
  return Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0;
}

export function isSanePtySize(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 1;
}

/** Explicit user redraw; the layout scheduler supplies the sole backend write boundary. */
export function requestTerminalRedraw(
  getTerminal: () => Terminal | null,
  getSessionId: () => string | null,
  canResize: () => boolean,
  send: (cols: number, rows: number) => void,
): () => void {
  const term = getTerminal();
  const id = getSessionId();
  if (!term || !id || !canResize() || !isSanePtySize(term.cols, term.rows)) return () => {};
  send(term.cols > 2 ? term.cols - 1 : 3, term.rows);
  const timer = setTimeout(() => {
    const current = getTerminal();
    if (getSessionId() === id && canResize() && current) send(current.cols, current.rows);
  }, 80);
  return () => clearTimeout(timer);
}
