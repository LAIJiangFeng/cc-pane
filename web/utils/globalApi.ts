import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useFileBrowserStore } from "@/stores/useFileBrowserStore";
import { useEditorTabsStore } from "@/stores/useEditorTabsStore";
import { collectTerminalPerformanceMetrics } from "@/services/performanceMetrics";
import { getTerminalOutputSchedulerStats } from "@/services/terminalOutputScheduler";
import { pendingChunkCount, pendingOverflowLatched } from "@/services/terminalPendingBufferPolicy";
import { processedEndSeqFor } from "@/services/terminalOutputAck";
import { getActivePresentationDebug } from "@/components/panes/terminalReplayPresentation";
import { invokeIfTauri } from "@/services/runtime";

interface CcPanesApi {
  openFileBrowser: (path: string) => void;
  openFile: (projectPath: string, filePath: string) => void;
  terminalDiagnostics: (sessionId: string) => Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    __ccPanes?: CcPanesApi;
  }
}

async function collectTerminalDiagnostics(sessionId: string): Promise<Record<string, unknown>> {
  const pane = collectTerminalPerformanceMetrics().terminals.find((item) => item.sessionId === sessionId) ?? null;
  let backendFlow: unknown = null;
  try {
    backendFlow = await invokeIfTauri("get_terminal_flow_diagnostics", { sessionId }) ?? null;
  } catch {
    backendFlow = null;
  }
  return {
    sessionId,
    writeFlow: pane
      ? {
          queuedChars: pane.queuedChars,
          inFlightChars: pane.inFlightChars,
          queuedWrites: pane.queuedWrites,
          oldestWaitMs: pane.oldestWaitMs,
          receivedChars: pane.receivedChars,
          writeCalls: pane.writeCalls,
          failedWrites: pane.failedWrites,
          callbackMaxMs: pane.callbackMaxMs,
          blocked: pane.blocked ?? false,
          pendingCallbacks: pane.pendingCallbacks ?? 0,
        }
      : null,
    outputScheduler: getTerminalOutputSchedulerStats(),
    pendingChunks: pendingChunkCount(sessionId),
    pendingOverflowLatched: pendingOverflowLatched(sessionId),
    processedEndSeq: processedEndSeqFor(sessionId),
    renderer: pane
      ? {
          activeRenderer: pane.renderer,
          requestedRenderer: pane.requestedRenderer,
          rendererReason: pane.rendererReason,
          contextLosses: pane.contextLosses,
          atlasClears: pane.atlasClears,
          callbackMaxMs: pane.callbackMaxMs,
        }
      : null,
    replay: getActivePresentationDebug(),
    backendFlow,
  };
}

export function registerGlobalApi(): void {
  window.__ccPanes = {
    openFileBrowser: (path: string) => {
      useFileBrowserStore.getState().navigateTo(path);
      const state = useActivityBarStore.getState();
      if (state.appViewMode !== "files") {
        state.toggleFilesMode();
      }
    },
    openFile: (projectPath: string, filePath: string) => {
      const fileName = filePath.split(/[/\\]/).pop() || "File";
      useEditorTabsStore.getState().openFile(projectPath, filePath, fileName);
      const state = useActivityBarStore.getState();
      if (state.appViewMode !== "files") {
        state.toggleFilesMode();
      }
    },
    terminalDiagnostics: (sessionId: string) => collectTerminalDiagnostics(sessionId),
  };
}
