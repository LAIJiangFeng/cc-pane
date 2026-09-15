import type { IDisposable, Terminal } from "@xterm/xterm";

type Kind = "key" | "composition-update" | "composition-commit" | "data-to-parsed-render";
interface Sample {
  kind: Kind;
  trusted: boolean;
  atMs: number;
  queueMs?: number;
  dispatchMs?: number;
  nextFrameMs?: number;
  afterFrameTaskMs?: number;
  parsedRenderMs?: number;
}
interface ProbeOptions {
  terminals?: Array<Pick<Terminal, "textarea" | "onData" | "onRender" | "onWriteParsed">>;
  durationMs?: number;
  capacity?: number;
}

export function summarizeInputDurations(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, p50: null, p95: null, max: null };
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

type ObservedTerminal = NonNullable<ProbeOptions["terminals"]>[number];
interface ProbeState {
  startedAt: string; capacity: number; durationMs: number; terminalCount: number;
  stopped: boolean; frame: number | null; droppedSamples: number; totalSamples: number;
  longTaskCount: number; longTaskMaxMs: number;
  geometry: { calls: number; totalMs: number; maxMs: number };
  samples: Sample[]; pending: Set<Sample>; lastInput: WeakMap<HTMLTextAreaElement, Sample>;
  timers: Set<ReturnType<typeof setTimeout>>; cleanups: Array<() => void>;
}

function remember(state: ProbeState, sample: Sample) {
  if (state.stopped) return;
  state.totalSamples++;
  if (state.samples.length >= state.capacity) { state.samples.shift(); state.droppedSamples++; }
  state.samples.push(sample);
}

function later(state: ProbeState, callback: () => void, delay: number) {
  const timer = setTimeout(() => { state.timers.delete(timer); if (!state.stopped) callback(); }, delay);
  state.timers.add(timer);
}

function requestMeasurementFrame(state: ProbeState) {
  if (state.frame !== null) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = null;
    if (state.stopped) return;
    const batch = [...state.pending];
    state.pending.clear();
    const at = performance.now();
    for (const sample of batch) sample.nextFrameMs = at - sample.atMs;
    later(state, () => {
      const after = performance.now();
      for (const sample of batch) { sample.afterFrameTaskMs = after - sample.atMs; remember(state, sample); }
    }, 0);
  });
}

function attachDomEvents(state: ProbeState) {
  const events = new WeakMap<Event, Sample>();
  const capture = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) ||
      !target.matches("[data-cc-panes-terminal-input], .xterm-helper-textarea")) return;
    if (state.pending.size >= 32) { state.droppedSamples++; return; }
    const at = performance.now();
    const timestamp = event.timeStamp > performance.timeOrigin ? event.timeStamp - performance.timeOrigin : event.timeStamp;
    const sample: Sample = {
      kind: event.type === "keydown" ? "key" : event.type === "compositionupdate" ? "composition-update" : "composition-commit",
      trusted: event.isTrusted, atMs: at,
      queueMs: timestamp >= 0 && at >= timestamp && at - timestamp <= 60_000 ? at - timestamp : undefined,
    };
    events.set(event, sample);
    state.lastInput.set(target, sample);
    state.pending.add(sample);
    requestMeasurementFrame(state);
  };
  const dispatched = (event: Event) => {
    const sample = events.get(event);
    // xterm may stop keydown propagation; don't invent a dispatch duration.
    if (sample) sample.dispatchMs = performance.now() - sample.atMs;
  };
  for (const type of ["keydown", "compositionupdate", "compositionend"]) {
    document.addEventListener(type, capture, { capture: true, passive: true });
    document.addEventListener(type, dispatched, { passive: true });
    state.cleanups.push(() => {
      document.removeEventListener(type, capture, true);
      document.removeEventListener(type, dispatched);
    });
  }
}

function attachGeometryTiming(state: ProbeState) {
  const original = Element.prototype.getBoundingClientRect;
  const measured = function (this: Element): DOMRect {
    if (!this.classList.contains("composition-view")) return original.call(this);
    const at = performance.now();
    try { return original.call(this); }
    finally {
      const elapsed = performance.now() - at;
      state.geometry.calls++;
      state.geometry.totalMs += elapsed;
      state.geometry.maxMs = Math.max(state.geometry.maxMs, elapsed);
    }
  };
  Element.prototype.getBoundingClientRect = measured;
  state.cleanups.push(() => {
    if (Element.prototype.getBoundingClientRect === measured) Element.prototype.getBoundingClientRect = original;
  });
}

function attachTerminal(state: ProbeState, term: ObservedTerminal) {
  let waiting: Array<{ sample: Sample; parsed: boolean }> = [];
  const disposables: IDisposable[] = [];
  disposables.push(term.onData(() => {
    const input = term.textarea && state.lastInput.get(term.textarea);
    const at = performance.now();
    if (!input || at - input.atMs > 1000) return;
    waiting = waiting.filter(row => at - row.sample.atMs <= 5000).slice(-31);
    waiting.push({ sample: { kind: "data-to-parsed-render", trusted: input.trusted, atMs: at }, parsed: false });
  }));
  disposables.push(term.onWriteParsed(() => { for (const row of waiting) row.parsed = true; }));
  disposables.push(term.onRender(() => {
    const at = performance.now();
    for (const row of waiting) {
      if (row.parsed && at - row.sample.atMs <= 5000) remember(state, { ...row.sample, parsedRenderMs: at - row.sample.atMs });
    }
    waiting = waiting.filter(row => !row.parsed && at - row.sample.atMs <= 5000);
  }));
  state.cleanups.push(() => { waiting = []; for (const item of disposables) item.dispose(); });
}

function attachLongTaskObserver(state: ProbeState) {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) { state.longTaskCount++; state.longTaskMaxMs = Math.max(state.longTaskMaxMs, entry.duration); }
  });
  try {
    observer.observe({ entryTypes: ["longtask"] });
    state.cleanups.push(() => observer.disconnect());
  } catch { observer.disconnect(); }
}

function snapshot(state: ProbeState) {
  return {
    startedAt: state.startedAt, active: !state.stopped, durationMs: state.durationMs, capacity: state.capacity,
    totalSamples: state.totalSamples, droppedSamples: state.droppedSamples, observedTerminals: state.terminalCount,
    visibility: document.visibilityState, focused: document.hasFocus(), longTaskCount: state.longTaskCount,
    longTaskMaxMs: state.longTaskMaxMs, compositionGeometry: { ...state.geometry },
    summary: (["key", "composition-update", "composition-commit", "data-to-parsed-render"] as const).map(kind => {
      const rows = state.samples.filter(sample => sample.kind === kind);
      const values = (field: keyof Sample) => rows.flatMap(row => typeof row[field] === "number" ? [row[field] as number] : []);
      return { kind, count: rows.length, trustedCount: rows.filter(row => row.trusted).length,
        queueMs: summarizeInputDurations(values("queueMs")), dispatchMs: summarizeInputDurations(values("dispatchMs")),
        nextFrameMs: summarizeInputDurations(values("nextFrameMs")), afterFrameTaskMs: summarizeInputDurations(values("afterFrameTaskMs")),
        parsedRenderMs: summarizeInputDurations(values("parsedRenderMs")) };
    }),
    samples: state.samples.map(sample => ({ ...sample })),
    limitations: ["Frame timings do not prove pixel presentation time.",
      "Parsed-render timings can include unrelated CLI output; controlled echo is needed for causality.",
      "Native IME candidate-window latency is not measured by this DOM probe."],
  };
}

const bound = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value !== undefined && Number.isFinite(value) ? value : fallback));

/** Explicit DEV-only installation. Exports timings, never input/output text. */
export function installTerminalInputProbe(options: ProbeOptions = {}) {
  if (!import.meta.env.DEV) throw new Error("Input profiling is only available in DEV");
  const state: ProbeState = {
    startedAt: new Date().toISOString(), capacity: bound(options.capacity, 256, 8, 512),
    durationMs: bound(options.durationMs, 600_000, 1000, 600_000), terminalCount: options.terminals?.length ?? 0,
    stopped: false, frame: null, droppedSamples: 0, totalSamples: 0, longTaskCount: 0, longTaskMaxMs: 0,
    geometry: { calls: 0, totalMs: 0, maxMs: 0 }, samples: [], pending: new Set(), lastInput: new WeakMap(),
    timers: new Set(), cleanups: [],
  };
  attachDomEvents(state);
  attachGeometryTiming(state);
  for (const term of options.terminals ?? []) attachTerminal(state, term);
  attachLongTaskObserver(state);
  const stop = () => {
    if (state.stopped) return;
    state.stopped = true;
    if (state.frame !== null) cancelAnimationFrame(state.frame);
    state.frame = null;
    state.pending.clear();
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    for (const cleanup of state.cleanups.splice(0)) cleanup();
    window.removeEventListener("pagehide", stop);
  };
  window.addEventListener("pagehide", stop);
  later(state, stop, state.durationMs);
  return { stop, snapshot: () => snapshot(state) };
}
