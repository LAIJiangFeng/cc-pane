import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalRecoverySnapshot } from "@/types";
import { replayAttachedSession } from "./terminalReplay";
import { resyncFromReplaySnapshot } from "./terminalResync";
import { createHibernatedTerminalState } from "./terminalHibernation";
import { replayAttachOrWake } from "./useTerminalHibernation";
import { deferTerminalLayoutDuringReplay, withTerminalReplayPresentation } from "./terminalReplayPresentation";
import { restoreTerminalReplayGeometry } from "./terminalReplayGeometry";

const terminals: Terminal[] = [];
const write = (term: Terminal, data: string) => new Promise<void>(resolve => term.write(data, resolve));
function terminal(cols = 80, rows = 24) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  terminals.push(term);
  return term;
}

async function fullscreenSnapshot(): Promise<TerminalRecoverySnapshot> {
  const source = terminal(81, 55);
  const serializer = new SerializeAddon();
  source.loadAddon(serializer);
  let content = "\x1b[?1049h\x1b[2J";
  for (let row = 1; row <= 55; row++) content += `\x1b[${row};1HROW_${row}`;
  await write(source, content + "\x1b[54;3H");
  return {
    checkpoint: { checkpointEpoch: "7", anchorSeq: 1, snapshotAnsi: serializer.serialize(),
      cols: 81, rows: 55, bufferMode: "alternate", checkpointedAtMs: 1 },
    delta: "\x1b[30;60HDELTA\x1b[54;3H", bufferMode: "alternate", endSeq: 2, checkpointEpoch: "7",
  };
}

function expectFullscreen(term: Terminal) {
  expect([term.cols, term.rows]).toEqual([81, 55]);
  expect(term.buffer.active.type).toBe("alternate");
  expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([2, 53]);
  // The first rows are lost permanently if the snapshot was parsed at 80x24.
  term.resize(137, 55);
  const lines = Array.from({ length: 55 }, (_, row) => term.buffer.active.getLine(row)!.translateToString(true));
  expect(lines.map(line => line.split(" ")[0])).toEqual(Array.from({ length: 55 }, (_, row) => `ROW_${row + 1}`));
  expect(lines[29].slice(59)).toBe("DELTA");
}

afterEach(() => terminals.splice(0).forEach(term => term.dispose()));

describe("replay uses the saved terminal grid", () => {
  it.each(["attach", "resync"])("%s preserves a fullscreen checkpoint and delta before fitting the new window", async mode => {
    const snapshot = await fullscreenSnapshot();
    const term = terminal();
    const options = { term, sessionId: `geometry-${mode}`, getRecoverySnapshot: async () => snapshot,
      writeData: (data: string) => write(term, data), writeCheckpointData: (data: string) => write(term, data),
      syncTrackedBufferType: vi.fn(), debugLog: vi.fn() };
    if (mode === "attach") await replayAttachedSession(options);
    else expect(await resyncFromReplaySnapshot({ ...options, reason: "daemon-desync" })).toBe(true);
    expectFullscreen(term);
  });

  it.each([false, true])("wake preserves the screen and pending output (overflow=%s)", async overflow => {
    const snapshot = await fullscreenSnapshot();
    const term = terminal();
    const wake = createHibernatedTerminalState({ sessionId: "geometry-wake",
      base: snapshot.checkpoint!.snapshotAnsi, cols: 81, rows: 55 });
    wake.appendRendered(snapshot.delta);
    if (overflow) wake.markDesynced();
    const getRecoverySnapshot = vi.fn(async () => snapshot);
    await replayAttachOrWake({ term, sessionId: wake.sessionId, wake, getRecoverySnapshot,
      renderTerminalData: data => data, renderCheckpointData: data => data,
      writeTerminalData: data => write(term, data), syncTrackedBufferType: vi.fn(),
      showReconnectHint: false, debugLog: vi.fn() });
    expect(getRecoverySnapshot).toHaveBeenCalledTimes(overflow ? 1 : 0);
    expectFullscreen(term);
  });

  it("a cancelled snapshot fetch does not resize or write into the replaced terminal", async () => {
    const snapshot = await fullscreenSnapshot();
    const term = terminal();
    const resize = vi.spyOn(term, "resize");
    const writeData = vi.fn();
    await replayAttachedSession({ term, sessionId: "geometry-cancelled", canWrite: () => false,
      getRecoverySnapshot: async () => snapshot, writeData, writeCheckpointData: writeData,
      syncTrackedBufferType: vi.fn(), debugLog: vi.fn() });
    expect(resize).not.toHaveBeenCalled();
    expect(writeData).not.toHaveBeenCalled();
  });

  it("keeps the sleep geometry when recovery falls back to a raw snapshot without a checkpoint", async () => {
    const snapshot = await fullscreenSnapshot();
    const term = terminal();
    const wake = createHibernatedTerminalState({ sessionId: "geometry-raw", base: "", cols: 81, rows: 55 });
    wake.markDesynced();
    await replayAttachOrWake({ term, sessionId: wake.sessionId, wake,
      getRecoverySnapshot: async () => ({ ...snapshot, checkpoint: null,
        delta: snapshot.checkpoint!.snapshotAnsi + snapshot.delta }),
      renderTerminalData: data => data, renderCheckpointData: data => data,
      writeTerminalData: data => write(term, data), syncTrackedBufferType: vi.fn(),
      showReconnectHint: false, debugLog: vi.fn() });
    expectFullscreen(term);
  });

  it("defers a window fit until nested replay completes even before a painted frame exists", async () => {
    const snapshot = await fullscreenSnapshot();
    const term = terminal();
    const owner = {};
    const fit = vi.fn(() => term.resize(137, 55));
    await withTerminalReplayPresentation(term, async () => {
      await replayAttachedSession({ term, sessionId: "geometry-unpainted",
        getRecoverySnapshot: async () => snapshot,
        writeCheckpointData: async data => {
          expect(deferTerminalLayoutDuringReplay(term, owner, fit)).toBe(true);
          await write(term, data);
          expect(fit).not.toHaveBeenCalled();
        },
        writeData: data => write(term, data), syncTrackedBufferType: vi.fn(), debugLog: vi.fn() });
      expect(fit).not.toHaveBeenCalled();
      expect([term.cols, term.rows]).toEqual([81, 55]);
    });
    expect(fit).toHaveBeenCalledTimes(1);
    expect([term.cols, term.rows]).toEqual([137, 55]);
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toBe("ROW_1");
    expect(term.buffer.active.getLine(54)!.translateToString(true)).toBe("ROW_55");
  });

  it("releases deferred layout after a failed replay", async () => {
    const term = terminal();
    const fit = vi.fn();
    const failure = new Error("write failed");
    await expect(withTerminalReplayPresentation(term, async () => {
      expect(deferTerminalLayoutDuringReplay(term, {}, fit)).toBe(true);
      throw failure;
    })).rejects.toBe(failure);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(deferTerminalLayoutDuringReplay(term, {}, fit)).toBe(false);
  });

  it.each([[0, 55], [81, -1], [NaN, 24], [80, Infinity], [80.5, 24], [65536, 24]])(
    "ignores invalid checkpoint dimensions %sx%s", (cols, rows) => {
      const term = terminal();
      const resize = vi.spyOn(term, "resize");
      restoreTerminalReplayGeometry(term, { cols, rows });
      expect(resize).not.toHaveBeenCalled();
      expect([term.cols, term.rows]).toEqual([80, 24]);
    },
  );
});
