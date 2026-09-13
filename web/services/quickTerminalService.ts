/**
 * F1 全局快捷终端服务（docs/105）— Quake 式下拉终端的前端入口。
 *
 * 后端单例窗口 `popup-quick-terminal` 由全局热键或命令面板 toggle；
 * hide 不销毁，PTY/滚动缓冲/光标全保留。
 */

import { invokeIfTauri, isTauriRuntime } from "./runtime";

/** 快捷终端窗口 label（与后端 QUICK_TERMINAL_LABEL 常量一致） */
export const QUICK_TERMINAL_LABEL = "popup-quick-terminal";

/** 切换快捷终端可见性（命令面板 / 设置 UI 入口；热键路径在后端直接触发） */
export async function toggleQuickTerminal(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeIfTauri("toggle_quick_terminal");
}

/** 隐藏快捷终端。快捷终端窗口失焦自动收起（autoHideOnBlur）时由前端调用。 */
export async function hideQuickTerminal(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeIfTauri("hide_quick_terminal");
}

/**
 * 更新快捷终端全局热键（设置 UI 保存时调用）。
 * 后端先注销 oldShortcut 再注册 newShortcut；newShortcut 为空 = 仅注销。
 */
export async function updateQuickTerminalShortcut(
  oldShortcut: string,
  newShortcut: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeIfTauri("quick_terminal_update_shortcut", { oldShortcut, newShortcut });
}

/** 当前窗口是否为快捷终端（popup 窗口内按 tabData.mode 判定，见 PopupTerminalWindow） */
export function isQuickTerminalTabData(data: { mode?: string } | null | undefined): boolean {
  return data?.mode === "quick";
}
