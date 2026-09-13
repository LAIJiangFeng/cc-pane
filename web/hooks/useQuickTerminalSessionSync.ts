/**
 * 主窗口侧镜像「哪条会话住在快捷终端窗口里」（docs/105 F1.4）。
 *
 * 快捷终端的 tab 不属于任何布局，`findTabBySessionAcrossLayouts` 永远查不到它，
 * 所以主窗口无法定位那条会话的通知、也没法把它接管进来。后端用
 * `QuickTerminalSessionStore` 记下这条映射并在变更时广播，本 hook 在主窗口挂一次：
 * 订阅事件 + 启动时补查一次（快捷窗口可能先于主窗口重建造出会话）。
 *
 * 只挂在主窗口（MainApp）。快捷终端窗口自己负责上报，不需要订阅。
 */
import { useEffect } from "react";

import { subscribeQuickTerminalSession } from "@/services/quickTerminalService";

export function useQuickTerminalSessionSync(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void subscribeQuickTerminalSession()
      .then((fn) => {
        // 订阅是异步建立的：组件已卸载就立刻退订，别把监听留在主窗口里。
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((error: unknown) => {
        // 非 Tauri 运行时 / 旧版后端没这些命令：回退自然失效，不该刷错误给用户。
        console.warn("[quickTerminal] session sync unavailable:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
