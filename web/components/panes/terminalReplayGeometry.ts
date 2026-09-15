/** VT cursor positions and soft wraps are relative to the grid that produced them. */
export interface TerminalReplayGeometry {
  readonly cols: number;
  readonly rows: number;
}

export interface ReplayGeometryTerminal {
  cols?: number;
  rows?: number;
  resize?: (cols: number, rows: number) => void;
}

interface ReplayLayoutLock {
  depth: number;
  layouts: Map<object, () => void>;
}

const layoutLocks = new WeakMap<object, ReplayLayoutLock>();

/** The geometry lock also covers a fresh/hidden view with no frame to freeze. */
export function holdTerminalReplayGeometry(term: object): () => void {
  const lock = layoutLocks.get(term) ?? { depth: 0, layouts: new Map() };
  layoutLocks.set(term, lock);
  lock.depth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lock.depth > 0) return;
    layoutLocks.delete(term);
    for (const apply of lock.layouts.values()) {
      try { apply(); }
      catch (error) { console.warn("[terminal-replay] Could not apply deferred layout", error); }
    }
    lock.layouts.clear();
  };
}

export function deferTerminalReplayGeometryLayout(term: object, owner: object, apply: () => void): boolean {
  const lock = layoutLocks.get(term);
  if (!lock) return false;
  lock.layouts.set(owner, apply);
  return true;
}

/**
 * Resize only the local emulator, before parsing any saved VT. The layout scheduler
 * fits the current container and synchronizes the PTY after replay has settled.
 * Restoring the fresh instance's default 80x24 here would discard recovered rows.
 */
export function restoreTerminalReplayGeometry(
  term: ReplayGeometryTerminal,
  geometry: TerminalReplayGeometry,
): void {
  const { cols, rows } = geometry;
  // Checkpoints use u16 dimensions on the wire. Ignore malformed/legacy metadata.
  if (!Number.isInteger(cols) || !Number.isInteger(rows)
    || cols < 2 || rows < 1 || cols > 0xffff || rows > 0xffff) return;
  if (term.cols !== cols || term.rows !== rows) term.resize?.(cols, rows);
}
