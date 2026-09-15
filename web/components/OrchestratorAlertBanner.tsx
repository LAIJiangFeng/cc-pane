import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrchestratorStatus } from "@/hooks/useOrchestratorStatus";
import {
  normalizeNotification,
  useNotificationStore,
} from "@/stores/useNotificationStore";
import type { OrchestratorStatus } from "@/types";

/** 稳定 id：同一故障周期内更新正文，不刷屏。 */
export const ORCHESTRATOR_ALERT_NOTIFICATION_ID = "orchestrator-mcp-alert";

function isOrchestratorAlerting(status: OrchestratorStatus | null): boolean {
  if (!status || status.lifecycle === "ready") return false;
  return !(status.lifecycle === "binding" && status.lastError == null);
}

function formatRetryTime(timestamp: number | null): string | null {
  if (timestamp == null) return null;
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * MCP 编排器起不来时发到右下角通知中心（可关闭），不再占顶部通栏。
 * 本组件不渲染 DOM，只把 lifecycle 同步成一张稳定 id 的通知卡。
 */
export default function OrchestratorAlertBanner() {
  const { t } = useTranslation("settings");
  const status = useOrchestratorStatus();
  const alertVisible = useNotificationStore((state) =>
    state.activeToastIds.includes(ORCHESTRATOR_ALERT_NOTIFICATION_ID),
  );
  const dismissedThisEpisode = useRef(false);
  const shownThisEpisode = useRef(false);
  const alerting = isOrchestratorAlerting(status);

  useEffect(() => {
    const store = useNotificationStore.getState();
    if (!alerting || !status) {
      dismissedThisEpisode.current = false;
      shownThisEpisode.current = false;
      if (store.activeToastIds.includes(ORCHESTRATOR_ALERT_NOTIFICATION_ID)) {
        store.dismissToast(ORCHESTRATOR_ALERT_NOTIFICATION_ID);
      }
      return;
    }

    if (dismissedThisEpisode.current) return;
    if (shownThisEpisode.current && !alertVisible) {
      dismissedThisEpisode.current = true;
      return;
    }

    const retryTime = formatRetryTime(status.nextRetryAt);
    const title = status.lifecycle === "failed"
      ? t("orchestratorAlert.failedTitle")
      : retryTime
        ? t("orchestratorAlert.retrying", { attempt: status.attempt, time: retryTime })
        : t("orchestratorAlert.attempting", { attempt: status.attempt });
    const body = [t("orchestratorAlert.notificationBody"), status.lastError]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n\n");

    store.upsert(
      normalizeNotification({
        id: ORCHESTRATOR_ALERT_NOTIFICATION_ID,
        kind: "orchestrator_failed",
        title,
        body,
        source: "MCP",
      }),
    );
    store.showToast(ORCHESTRATOR_ALERT_NOTIFICATION_ID);
    shownThisEpisode.current = true;
  }, [alerting, status, t, alertVisible]);

  return null;
}
