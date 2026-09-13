// 通知卡片/历史行共用的定位与跳转动作。
// 会话定位优先走 panesStore 反查（布局名 + 窗格序号）；跨布局查不到时回退到
// 全局快捷终端登记（F1.4）；两者都查不到时返回 null，UI 省略定位段。
import { toastErr, toastOk } from "@/lib/feedback";
import type { TFunction } from "i18next";
import { focusTab } from "@/hooks/useFocusTab";
import { collectPanels } from "@/lib/paneTree";
import { focusPoppedOutTab, markTabReclaimed } from "@/services/popupWindowService";
import {
  destroyQuickTerminal,
  focusQuickTerminalWindow,
  getMirroredQuickTerminalSession,
} from "@/services/quickTerminalService";
import { terminalService } from "@/services/terminalService";
import { useActivityBarStore, useOrchestratorStore, usePanesStore } from "@/stores";
import { isQuickTerminalSession } from "@/stores/useQuickTerminalSessionStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { asTabId } from "@/types/ids";

/**
 * 通知能定位到的会话位置。
 *
 * - `layout`：会话在主窗口某个布局的分屏里，有布局名 + 窗格序号。
 * - `quickTerminal`：会话住在全局快捷终端窗口里（docs/105 F1.4）。它不在任何布局，
 *   没有布局名/窗格序号，定位文案与「聚焦」动作都不同（唤出快捷窗口而非切分屏）。
 */
export type NotificationSessionLocation =
  | { kind: "layout"; layoutName: string; paneIndex: number }
  | { kind: "quickTerminal" };

export function locateNotificationSession(
  sessionId: string | undefined,
): NotificationSessionLocation | null {
  if (!sessionId) return null;
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
  if (location) {
    const panels = collectPanels(location.tree);
    const paneIndex = panels.findIndex((panel) => panel.id === location.panel.id);
    return {
      kind: "layout",
      layoutName: location.layoutName,
      paneIndex: paneIndex >= 0 ? paneIndex + 1 : 1,
    };
  }
  // 回退（F1.4）：跨布局查不到，但这条会话可能住在全局快捷终端窗口里。
  // 快捷终端的 tab 不在任何布局，findTabBySessionAcrossLayouts 永远返回 null，
  // 不回退的话这类通知连「聚焦会话」按钮都不渲染。
  if (isQuickTerminalSession(sessionId)) return { kind: "quickTerminal" };
  return null;
}

/**
 * 与 OrchestratorTaskCard.focusSessionTab 同款：找到 tab 即聚焦并切回分屏视图。
 *
 * docs/105 F7.3：tab 若已弹出成独立系统窗口，主窗口里那个面板只剩「已弹出」占位符，
 * 聚焦它等于没定位到任何东西——终端真身在 `popup-<tabId>` 窗口里。所以先认弹出态，
 * 把真身窗口唤到前台；唤不回（窗口已关但回收事件丢失）才自愈回收，退回主窗口内定位。
 * 因此返回值是 Promise：定位成功与否需要等窗口聚焦结果。
 *
 * docs/105 F1.4：会话也可能住在全局快捷终端窗口里。那种会话不属于任何布局，
 * 反查必然落空，但终端真身在 `popup-quick-terminal`，所以回退到唤出那个窗口。
 * 先查布局、后查快捷终端：一旦被接管进主窗口，会话就有布局了，该走正常路径。
 */
export async function focusNotificationSession(sessionId: string): Promise<boolean> {
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
  if (!location) return isQuickTerminalSession(sessionId) && focusQuickTerminalWindow();
  const tabId = location.tab.id;

  if (usePanesStore.getState().isTabPoppedOut(tabId)) {
    if (await focusPoppedOutTab(tabId)) {
      // 主窗口内也切到那个面板：用户从弹出窗口切回来时停在同一个 tab 上。
      focusTab(asTabId(tabId), { switchAppView: true });
      return true;
    }
    // 窗口已不存在：两份真相一起回收（store 弹出态 + service label 映射），
    // reclaimKey 递增让 TerminalView 在主窗口重新挂载。
    usePanesStore.getState().markTabReclaimed(tabId);
    markTabReclaimed(tabId);
  }

  return focusTab(asTabId(tabId), { switchAppView: true });
}

export function jumpToNotificationTask(taskBindingId: string): void {
  useOrchestratorStore.getState().setSelectedTaskId(taskBindingId);
  useActivityBarStore.getState().openOrchestrationOverlay();
}

export type AdoptQuickTerminalResult =
  | "adopted"
  | "not-found"
  | "claim-failed"
  | "adopt-failed";

/**
 * 把住在快捷终端窗口里的会话接进主窗口（docs/105 F1.4）。
 *
 * 与状态栏资源管理器的 `adoptSession`（SystemResourceSegment）同构，但有两点差异，
 * 都来自「快捷终端会话不进 savedSessions」这个事实：
 *
 * 1. **元信息来源**：那里读 `savedSessions.get(sessionId)`，这里读后端广播来的登记项
 *    （`getMirroredQuickTerminalSession`）。`projectPath` 必须自带，否则建出的 tab 一旦
 *    被重建会在错误目录里重启。
 * 2. **不需要 runtimeKind 指纹校验**：`resolveAdoptRuntime` 那道关是为 wsl/ssh 会话准备的
 *    （重建时要 cwd/host 才能起对东西）。快捷终端窗口给 TerminalView 传的是纯 shell
 *    （不传 cliTool/launchClaude/wsl/ssh → `resolveCliTool` 落到 `"none"`、
 *    `resolveRuntimeKind` 落到 `"local"`），所以恒为 local，无指纹可缺。
 *
 * 顺序要点：
 *
 * - **先 claim 再建 tab**：拿到写权限才敢让主窗口去 reattach 这条 PTY。claim 的 owner
 *   是 `DaemonClient.instance_id`，而 backend 是 Tauri 进程级 managed state，主窗口与快捷
 *   窗口共享同一个 → 同 owner → 重入放行。
 * - **`markSessionLive`**：主窗口的 `useTerminalStatusStore` 最多 15s 才全量刷一次，
 *   刚建的快捷会话可能还不在缓存里；`findLiveSavedSessionId` 读不到就会判定非 live，
 *   走 relaunch **新建一条重复 PTY**（用户在两个窗口里看到两个 shell）。先标 live 逼它
 *   走 reattach。该函数只在 key 不存在时写入，不会覆盖已有的真实状态。
 * - **最后才销毁快捷窗口**：反过来会在 adopt 失败时同时丢掉窗口和 tab，用户两头落空。
 *   销毁只关窗 + 清登记，不杀 PTY（`destroy_quick_terminal` / lib.rs:2867 同此语义）；
 *   TerminalView 的 unmount 也不杀会话（`killSessionOnUnmounted*` 只用于 init 期间的
 *   竞态回滚），回调解绑是 per-view 的，不会影响主窗口刚挂上的那份。
 *
 * 纯动作层：不做翻译，失败原因以联合类型返回，由 UI 包装（`handleAdoptQuickTerminal`）
 * 决定怎么呈现，这样测试与复用时都不必塞一个 i18n 函数进来。
 */
export async function adoptQuickTerminalSession(
  sessionId: string,
): Promise<AdoptQuickTerminalResult> {
  const record = getMirroredQuickTerminalSession();
  // 登记已失效（窗口被关 / 会话已退出）：没有 projectPath 就不建 tab，
  // 宁可不接管也不要让它在错误的仓库里重启。
  if (!record || record.sessionId !== sessionId) return "not-found";

  let granted = false;
  try {
    granted = await terminalService.adoptSession(sessionId);
  } catch {
    granted = false;
  }
  if (!granted) return "claim-failed";

  // 接管前先把这条会话在主窗口侧标成 live，逼 TerminalView 走 reattach 而不是 relaunch。
  useTerminalStatusStore.getState().markSessionLive(sessionId);

  const adoptedTabId = usePanesStore.getState().adoptSession(sessionId, {
    projectPath: record.projectPath,
    // 如实标注：快捷终端起的是纯 shell（见函数注释第 2 点）。
    cliTool: "none",
    customTitle: record.title,
  });
  if (!adoptedTabId) {
    await terminalService.releaseSession(sessionId).catch(() => {
      // 释放失败只影响写租约，30 秒后自动过期，不值得把错误抛给用户。
    });
    return "adopt-failed";
  }
  usePanesStore.getState().setSessionLeaseReadOnly(sessionId, false);

  // 主窗口这边已落地，快捷窗口可以撤了。失败不回报：tab 已可用，
  // 用户大不了自己按热键把那个窗口收起来。
  await destroyQuickTerminal().catch(() => {});

  focusTab(asTabId(adoptedTabId), { switchAppView: true });
  return "adopted";
}

/** 「在主窗口打开」的 UI 入口：接管并把失败原因翻译成 toast。 */
export async function handleAdoptQuickTerminal(
  sessionId: string | undefined,
  t: TFunction<"notifications">,
): Promise<boolean> {
  if (!sessionId) return false;
  const result = await adoptQuickTerminalSession(sessionId);
  if (result === "adopted") {
    toastOk(t("center.adoptFromQuickTerminal.ok", { defaultValue: "已在主窗口打开" }));
    return true;
  }
  toastErr(
    t(`center.adoptFromQuickTerminal.${result}` as never, {
      defaultValue: "无法在主窗口打开该会话",
    }),
  );
  return false;
}

export function formatRelativeTime(timestamp: number, t: TFunction<"notifications">): string {
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return t("center.timeJustNow", { defaultValue: "刚刚" });
  if (mins < 60) return t("center.timeMinutesAgo", { count: mins, defaultValue: `${mins} 分钟前` });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("center.timeHoursAgo", { count: hours, defaultValue: `${hours} 小时前` });
  const days = Math.floor(hours / 24);
  return t("center.timeDaysAgo", { count: days, defaultValue: `${days} 天前` });
}

const KIND_TITLE_KEYS = new Set([
  "session_exited",
  "waiting_input",
  "turn_end",
  "error",
  "slow_tool",
]);

/** 内置 kind 用本地化标题（后端 title 是英文硬编码）；任意 MCP kind 用其自带 title。 */
export function displayTitle(
  kind: string,
  title: string,
  t: TFunction<"notifications">,
): string {
  if (KIND_TITLE_KEYS.has(kind)) {
    return t(`center.kindTitle.${kind}` as never, { defaultValue: title });
  }
  return title;
}
