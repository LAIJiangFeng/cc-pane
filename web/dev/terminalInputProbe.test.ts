import { afterEach, describe, expect, it, vi } from "vitest";
import { installTerminalInputProbe, summarizeInputDurations } from "./terminalInputProbe";

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });

function setup(capacity = 256) {
  vi.useFakeTimers();
  const textarea = document.createElement("textarea");
  textarea.className = "xterm-helper-textarea";
  document.body.append(textarea);
  const probe = installTerminalInputProbe({ capacity });
  stop = probe.stop;
  return { textarea, probe };
}

describe("DEV terminal input probe", () => {
  it("exports timings without recording keys, composition text or textarea contents", async () => {
    const { textarea, probe } = setup();
    textarea.value = "PRIVATE_TERMINAL_DRAFT";
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "PRIVATE_COMPOSITION" }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PRIVATE_KEY" }));
    await vi.advanceTimersByTimeAsync(40);
    const result = probe.snapshot();
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0]).toMatchObject({ kind: "composition-update", trusted: false });
    expect(result.samples[0].nextFrameMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("ignores ordinary form inputs and bounds retained samples", async () => {
    const { textarea, probe } = setup(8);
    const ordinary = document.createElement("textarea");
    document.body.append(ordinary);
    ordinary.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
    for (let i = 0; i < 12; i++) {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "x" }));
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(probe.snapshot()).toMatchObject({ totalSamples: 12, droppedSamples: 4 });
    expect(probe.snapshot().samples).toHaveLength(8);
  });

  it("requires parsed output before treating a render as an input correlation", () => {
    vi.useFakeTimers();
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.append(textarea);
    const callbacks: Record<string, () => void> = {};
    const disposed = vi.fn();
    const event = <T,>(key: string, value: T) => (callback: (value: T) => void) => {
      callbacks[key] = () => callback(value); return { dispose: disposed };
    };
    const probe = installTerminalInputProbe({ terminals: [{ textarea, onData: event("data", "x"), onWriteParsed: event("parsed", undefined), onRender: event("render", { start: 0, end: 1 }) }] });
    stop = probe.stop;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "x" }));
    callbacks.data(); callbacks.render();
    expect(probe.snapshot().samples).toHaveLength(0);
    callbacks.parsed(); callbacks.render();
    expect(probe.snapshot().samples[0].kind).toBe("data-to-parsed-render");
    probe.stop();
    expect(disposed).toHaveBeenCalledTimes(3);
  });

  it("restores the geometry hook and cancels pending work when stopped", async () => {
    const original = Element.prototype.getBoundingClientRect;
    const { textarea, probe } = setup();
    const view = document.createElement("div"); view.className = "composition-view";
    view.getBoundingClientRect();
    expect(probe.snapshot().compositionGeometry.calls).toBe(1);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "x" }));
    probe.stop(); probe.stop();
    await vi.advanceTimersByTimeAsync(40);
    expect(probe.snapshot()).toMatchObject({ active: false, totalSamples: 0 });
    expect(Element.prototype.getBoundingClientRect).toBe(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("automatically stops a bounded capture", async () => {
    vi.useFakeTimers();
    const probe = installTerminalInputProbe({ durationMs: 1000 }); stop = probe.stop;
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.snapshot().active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports percentile boundaries and excludes non-finite durations", () => {
    expect(summarizeInputDurations([])).toEqual({ count: 0, p50: null, p95: null, max: null });
    expect(summarizeInputDurations([4, 2, Infinity, 1, 3, NaN])).toEqual({ count: 4, p50: 2, p95: 4, max: 4 });
  });
});
