/**
 * F1 全局快捷终端服务（docs/105）— Quake 式下拉终端的前端入口。
 *
 * 后端单例窗口 `popup-quick-terminal` 由全局热键或命令面板 toggle；
 * hide 不销毁，PTY/滚动缓冲/光标全保留。
 *
 * F1.4：快捷终端的 tab 不在任何布局里（它是独立窗口自建会话），主窗口的
 * `findTabBySessionAcrossLayouts` 永远查不到它。后端用 `QuickTerminalSessionStore`
 * 记下「哪条会话住在快捷窗口里」并广播变更，本模块在主窗口侧镜像成一份同步缓存，
 * 让通知定位与「在主窗口打开」接管能命中这条会话。
 */

import type { UnlistenFn } from "@tauri-apps/api/event";

import { useQuickTerminalSessionStore } from "@/stores/useQuickTerminalSessionStore";

import { invokeIfTauri, isTauriRuntime, listenIfTauri } from "./runtime";

/** 快捷终端窗口 label（与后端 QUICK_TERMINAL_LABEL 常量一致） */
export const QUICK_TERMINAL_LABEL = "popup-quick-terminal";

/**
 * 快捷终端会话登记项（对应后端 `QuickTerminalSessionRecord`）。
 *
 * 除 sessionId 外还带 projectPath/title：快捷终端会话不在任何布局里，也就不会被
 * 写进 savedSessions，主窗口接管（`panes.adoptSession`）时别处查不到它的 cwd。
 * 不带就只能拿空路径建 tab，而该 tab 一旦被重建会在错误目录里重启。
 */
export interface QuickTerminalSessionRecord {
  sessionId: string;
  projectPath: string;
  title?: string;
}

/** 与后端 QUICK_TERMINAL_SESSION_CHANGED_EVENT 一致 */
const SESSION_CHANGED_EVENT = "quick-terminal-session-changed";

/**
 * 上报快捷终端当前会话。快捷终端窗口在 onSessionCreated 时调用；
 * 传 null 表示会话已结束 / 窗口被销毁。后端仅在值真正变化时才广播。
 *
 * 本地也直接写镜像，而不是只等广播绕回来：后端 `app.emit` 会送达所有 webview
 * （含发起方自己），所以广播这条路是通的，但要等一次 IPC 往返。上报时同步写，
 * 让本窗口后续任何读取立刻看到登记，不受往返时序影响。
 */
export async function reportQuickTerminalSession(
  record: QuickTerminalSessionRecord | null,
): Promise<void> {
  applyRecord(record);
  if (!isTauriRuntime()) return;
  await invokeIfTauri("set_quick_terminal_session", {
    sessionId: record?.sessionId ?? null,
    projectPath: record?.projectPath ?? null,
    title: record?.title ?? null,
  });
}

function applyRecord(record: QuickTerminalSessionRecord | null): void {
  useQuickTerminalSessionStore.getState().setSession(record ?? null);
}

/** 同步读取镜像里的登记项（接管建 tab 需要 projectPath/title） */
export function getMirroredQuickTerminalSession(): QuickTerminalSessionRecord | null {
  return useQuickTerminalSessionStore.getState().session;
}

/**
 * 主动从后端补查一次登记并刷新镜像（主窗口启动 / 窗口重建时用）。
 * 非 Tauri 运行时与命令不可用时返回 null（回退自然失效，不影响主流程）。
 */
export async function refreshQuickTerminalSession(): Promise<QuickTerminalSessionRecord | null> {
  if (!isTauriRuntime()) return getMirroredQuickTerminalSession();
  try {
    const record = await invokeIfTauri<QuickTerminalSessionRecord | null>(
      "get_quick_terminal_session",
    );
    applyRecord(record ?? null);
  } catch {
    // 旧版后端没这个命令：保持现有镜像不动，不报错也不清。
  }
  return getMirroredQuickTerminalSession();
}

/**
 * 订阅快捷终端会话变更并立即补查一次，返回退订函数。
 * 在主窗口根组件挂载一次即可（快捷终端窗口自己上报，不需订阅）。
 */
export async function subscribeQuickTerminalSession(): Promise<UnlistenFn> {
  const unlisten = await listenIfTauri<QuickTerminalSessionRecord | null>(
    SESSION_CHANGED_EVENT,
    (event) => {
      applyRecord(event.payload ?? null);
    },
  );
  // 订阅建立前可能已有会话（快捷终端先开、主窗口后重建），补查一次补齐。
  await refreshQuickTerminalSession();
  return unlisten;
}

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
 * 把快捷终端窗口唤到前面（通知「聚焦会话」跨布局查不到时的回退）。
 * 复用 popup 聚焦命令：窗口隐藏/最小化时它会先还原再 focus。
 * 返回 `false` = 窗口已不存在（登记过期），调用方据此诚实上报定位失败。
 */
export async function focusQuickTerminalWindow(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const focused = await invokeIfTauri<boolean>("focus_popup_terminal_window", {
    label: QUICK_TERMINAL_LABEL,
  });
  return focused === true;
}

/**
 * 销毁快捷终端窗口（「在主窗口打开」接管后调用）。
 * 后端只关窗 + 清登记/tabData，不杀 PTY：主窗口 adopt 出的 tab 会 reattach
 * 到同一条会话，历史与运行状态全保留。
 */
export async function destroyQuickTerminal(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invokeIfTauri("destroy_quick_terminal");
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
