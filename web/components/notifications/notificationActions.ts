// 通知卡片/历史行共用的定位与跳转动作。
// 会话定位（布局名 + 窗格序号）来自 panesStore 反查；查不到时返回 null，UI 省略定位段。
import type { TFunction } from "i18next";
import { focusTab } from "@/hooks/useFocusTab";
import { collectPanels } from "@/lib/paneTree";
import { focusPoppedOutTab, markTabReclaimed } from "@/services/popupWindowService";
import { useActivityBarStore, useOrchestratorStore, usePanesStore } from "@/stores";
import { asTabId } from "@/types/ids";

export interface NotificationSessionLocation {
  layoutName: string;
  paneIndex: number;
}

export function locateNotificationSession(
  sessionId: string | undefined,
): NotificationSessionLocation | null {
  if (!sessionId) return null;
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
  if (!location) return null;
  const panels = collectPanels(location.tree);
  const paneIndex = panels.findIndex((panel) => panel.id === location.panel.id);
  return {
    layoutName: location.layoutName,
    paneIndex: paneIndex >= 0 ? paneIndex + 1 : 1,
  };
}

/**
 * 与 OrchestratorTaskCard.focusSessionTab 同款：找到 tab 即聚焦并切回分屏视图。
 *
 * docs/105 F7.3：tab 若已弹出成独立系统窗口，主窗口里那个面板只剩「已弹出」占位符，
 * 聚焦它等于没定位到任何东西——终端真身在 `popup-<tabId>` 窗口里。所以先认弹出态，
 * 把真身窗口唤到前台；唤不回（窗口已关但回收事件丢失）才自愈回收，退回主窗口内定位。
 * 因此返回值是 Promise：定位成功与否需要等窗口聚焦结果。
 */
export async function focusNotificationSession(sessionId: string): Promise<boolean> {
  const location = usePanesStore.getState().findTabBySessionAcrossLayouts(sessionId);
  if (!location) return false;
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
