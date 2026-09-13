// Tauri 文件拖放监听：drop 落在终端宿主内时把路径粘贴进终端。
// 从 TerminalView.tsx 拆出（纯代码移动，逻辑不变）。
//
// 路径按会话运行时呈现（docs/105 F2）：本地/WSL 做 shell 引号转义，WSL 额外把
// Windows 盘符路径转成 guest 的 `/mnt/<drive>/...`；SSH 会话不插入宿主本地路径
// （远端无法访问），改为诚实提示。
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import {
  formatTerminalPathsForShell,
  type TerminalRuntimeKind,
} from "../terminalDropPaths";
import { isDropInsideTerminalHost } from "../terminalDrop";

export interface TerminalDragDropDeps {
  getHost: () => HTMLDivElement | null;
  isMounted: () => boolean;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
  pasteText: (text: string, kind: string) => void;
  setUnlisten: (unlisten: () => void) => void;
  /** 会话运行时，决定路径如何呈现。缺省 local。 */
  getRuntimeKind?: () => TerminalRuntimeKind;
  /** SSH 会话收到本地路径拖放时的诚实降级提示（不插入无效路径）。 */
  onUnsupportedDrop?: (pathCount: number) => void;
}

export function attachTerminalDragDropListener({
  getHost,
  isMounted,
  debugLog,
  pasteText,
  setUnlisten,
  getRuntimeKind,
  onUnsupportedDrop,
}: TerminalDragDropDeps): void {
  if (isTauriRuntime()) {
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type !== "drop") return;

          const host = getHost();
          if (!host || !isDropInsideTerminalHost(host, payload.position)) return;

          const runtimeKind = getRuntimeKind?.() ?? "local";
          const text = formatTerminalPathsForShell(payload.paths, { runtimeKind });
          if (!text) {
            // SSH：本地路径在远端无意义，不插入。给用户一个明确说法。
            if (runtimeKind === "ssh" && payload.paths.length > 0) {
              debugLog("drag-drop.unsupported-runtime", {
                runtimeKind,
                pathCount: payload.paths.length,
              });
              onUnsupportedDrop?.(payload.paths.length);
            }
            return;
          }

          debugLog("drag-drop.paste", {
            pathCount: payload.paths.length,
            textLength: text.length,
            runtimeKind,
          });
          pasteText(text, "file-drop");
        })
        .then((unlisten) => {
          if (!isMounted()) {
            unlisten();
            return;
          }
          setUnlisten(unlisten);
        })
        .catch((error) => {
          debugLog("drag-drop.listener.failed", {
            error: getErrorMessage(error),
          });
        });
    } catch (error) {
      debugLog("drag-drop.listener.failed", {
        error: getErrorMessage(error),
      });
    }
  }
}
