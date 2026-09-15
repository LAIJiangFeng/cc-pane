import "@/i18n";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorStatus } from "@/types";
import { useOrchestratorStatus } from "@/hooks/useOrchestratorStatus";
import { useNotificationStore } from "@/stores/useNotificationStore";
import OrchestratorAlertBanner, {
  ORCHESTRATOR_ALERT_NOTIFICATION_ID,
} from "./OrchestratorAlertBanner";

vi.mock("@/hooks/useOrchestratorStatus", () => ({
  useOrchestratorStatus: vi.fn(),
}));

const status = (overrides: Partial<OrchestratorStatus>): OrchestratorStatus => ({
  port: null,
  bind: { host: "127.0.0.1", mode: "auto", reason: "test" },
  lifecycle: "binding",
  attempt: 1,
  lastError: "port occupied",
  nextRetryAt: Date.now() + 1_000,
  ...overrides,
});

function alertRecord() {
  return useNotificationStore
    .getState()
    .notifications.find((item) => item.id === ORCHESTRATOR_ALERT_NOTIFICATION_ID);
}

describe("OrchestratorAlertBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationStore.getState().clear();
  });

  it("绑定重试期间发到通知中心，不渲染顶部横幅", () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue(status({ attempt: 2 }));

    const view = render(<OrchestratorAlertBanner />);

    expect(view.container).toBeEmptyDOMElement();
    expect(useNotificationStore.getState().activeToastIds).toContain(
      ORCHESTRATOR_ALERT_NOTIFICATION_ID,
    );
    expect(alertRecord()?.title).toContain("第 2 次");
    expect(alertRecord()?.body).toContain("CC_PANES_ORCHESTRATOR_PORT");
    expect(alertRecord()?.kind).toBe("orchestrator_failed");
  });

  it("重试穷尽后标题改为 MCP 不可用，并带上错误详情", () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ lifecycle: "failed", attempt: 5, nextRetryAt: null, lastError: "port occupied" }),
    );

    render(<OrchestratorAlertBanner />);

    expect(alertRecord()?.title).toBe("MCP 服务未启动");
    expect(alertRecord()?.body).toContain("port occupied");
    expect(useNotificationStore.getState().activeToastIds).toContain(
      ORCHESTRATOR_ALERT_NOTIFICATION_ID,
    );
  });

  it("首次绑定尚未失败以及 ready 状态均不发通知", () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ attempt: 1, lastError: null, nextRetryAt: null }),
    );
    const view = render(<OrchestratorAlertBanner />);
    expect(useNotificationStore.getState().notifications).toEqual([]);

    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ lifecycle: "ready", port: 47822, attempt: null, lastError: null, nextRetryAt: null }),
    );
    view.rerender(<OrchestratorAlertBanner />);
    expect(useNotificationStore.getState().notifications).toEqual([]);
    expect(useNotificationStore.getState().activeToastIds).toEqual([]);
  });

  it("用户关掉卡片后，同一故障周期不再弹回", () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ lifecycle: "failed", attempt: 5, nextRetryAt: null }),
    );
    const view = render(<OrchestratorAlertBanner />);
    expect(useNotificationStore.getState().activeToastIds).toContain(
      ORCHESTRATOR_ALERT_NOTIFICATION_ID,
    );

    act(() => {
      useNotificationStore.getState().dismissToast(ORCHESTRATOR_ALERT_NOTIFICATION_ID);
    });
    view.rerender(<OrchestratorAlertBanner />);

    expect(useNotificationStore.getState().activeToastIds).not.toContain(
      ORCHESTRATOR_ALERT_NOTIFICATION_ID,
    );
  });

  it("恢复 ready 后再次失败会重新弹出", () => {
    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ lifecycle: "failed", attempt: 5, nextRetryAt: null }),
    );
    const view = render(<OrchestratorAlertBanner />);
    act(() => {
      useNotificationStore.getState().dismissToast(ORCHESTRATOR_ALERT_NOTIFICATION_ID);
    });
    view.rerender(<OrchestratorAlertBanner />);

    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ lifecycle: "ready", port: 47821, attempt: null, lastError: null, nextRetryAt: null }),
    );
    view.rerender(<OrchestratorAlertBanner />);

    vi.mocked(useOrchestratorStatus).mockReturnValue(
      status({ lifecycle: "failed", attempt: 5, nextRetryAt: null, lastError: "still occupied" }),
    );
    view.rerender(<OrchestratorAlertBanner />);

    expect(useNotificationStore.getState().activeToastIds).toContain(
      ORCHESTRATOR_ALERT_NOTIFICATION_ID,
    );
    expect(alertRecord()?.body).toContain("still occupied");
  });
});
