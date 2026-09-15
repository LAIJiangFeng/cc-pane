import { logInfoSafe } from "@/services/runtime";

/** Per-keystroke IME/input events. IPC to plugin-log on these stalls WebView2 composition. */
export function isHotInputDebugEvent(tag: string, event: string): boolean {
  return (
    event.startsWith("input.dom.") ||
    event.startsWith("input.xterm.") ||
    event.startsWith("input.queue.") ||
    event.startsWith("input.ipc.") ||
    event.startsWith("input-trace.") ||
    event.startsWith("ime-guard.") ||
    event === "layout.skip.unchanged" ||
    (tag === "terminal-service-debug" && event.startsWith("input."))
  );
}

function serializeDevPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, (_key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      return value;
    });
  } catch {
    return "\"[unserializable-payload]\"";
  }
}

export function devDebugLog(
  tag: string,
  event: string,
  payload: Record<string, unknown> = {}
): void {
  if (!import.meta.env.DEV) return;

  console.debug(`[${tag}] ${event}`, payload);

  // Keep the IME hot path off the Tauri log plugin. plugin-log IPC on every
  // compositionupdate/keydown hitchs pinyin in DEV even when layout is idle.
  if (isHotInputDebugEvent(tag, event)) return;

  logInfoSafe(`[${tag}] ${event} ${serializeDevPayload(payload)}`).catch(() => {});
}
