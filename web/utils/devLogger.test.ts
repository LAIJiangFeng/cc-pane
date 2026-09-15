import { describe, expect, it } from "vitest";
import { isHotInputDebugEvent } from "./devLogger";

describe("isHotInputDebugEvent", () => {
  it("treats per-keystroke IME and input logs as hot", () => {
    expect(isHotInputDebugEvent("terminal-debug", "input.dom.compositionupdate")).toBe(true);
    expect(isHotInputDebugEvent("terminal-debug", "input.dom.keydown")).toBe(true);
    expect(isHotInputDebugEvent("terminal-debug", "input.xterm.onData")).toBe(true);
    expect(isHotInputDebugEvent("terminal-debug", "input-trace.compositionupdate")).toBe(true);
    expect(isHotInputDebugEvent("terminal-debug", "ime-guard.compositionstart")).toBe(true);
    expect(isHotInputDebugEvent("terminal-service-debug", "input.queue.flush.begin")).toBe(true);
    expect(isHotInputDebugEvent("terminal-debug", "input.queue.enqueue")).toBe(true);
    expect(isHotInputDebugEvent("terminal-debug", "layout.skip.unchanged")).toBe(true);
  });

  it("keeps layout and session logs off the hot path", () => {
    expect(isHotInputDebugEvent("terminal-debug", "layout.applied")).toBe(false);
    expect(isHotInputDebugEvent("terminal-debug", "xterm.ready")).toBe(false);
    expect(isHotInputDebugEvent("terminal-service-debug", "listeners.init")).toBe(false);
  });
});
