import { describe, it, expect, beforeEach, vi } from "vitest";

// focusTab 是被测函数在主窗口内定位的统一出口；这里 mock 掉以隔离分屏 store 逻辑。
const focusTab = vi.fn();
vi.mock("@/hooks/useFocusTab", () => ({
  focusTab: (...args: unknown[]) => focusTab(...args),
}));

// 弹出窗口服务：focusPoppedOutTab 决定「真身窗口能否唤到前台」，markTabReclaimed 是
// 自愈回退时要清掉的 service 侧 label 映射。
const focusPoppedOutTab = vi.fn();
const serviceMarkTabReclaimed = vi.fn();
vi.mock("@/services/popupWindowService", () => ({
  focusPoppedOutTab: (...args: unknown[]) => focusPoppedOutTab(...args),
  markTabReclaimed: (...args: unknown[]) => serviceMarkTabReclaimed(...args),
}));

// panesStore：只 stub 被测函数真正读到的几个方法/字段。
const findTabBySessionAcrossLayouts = vi.fn();
const isTabPoppedOut = vi.fn();
const storeMarkTabReclaimed = vi.fn();
vi.mock("@/stores", () => ({
  usePanesStore: {
    getState: () => ({
      findTabBySessionAcrossLayouts,
      isTabPoppedOut,
      markTabReclaimed: storeMarkTabReclaimed,
    }),
  },
  useOrchestratorStore: { getState: () => ({ setSelectedTaskId: vi.fn() }) },
  useActivityBarStore: { getState: () => ({ openOrchestrationOverlay: vi.fn() }) },
}));

import { focusNotificationSession } from "./notificationActions";

function stubLocation(tabId: string) {
  findTabBySessionAcrossLayouts.mockReturnValue({
    tab: { id: tabId },
    panel: { id: "pane-1" },
    tree: {},
    layoutName: "Layout A",
    layoutId: "layout-a",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  focusTab.mockReturnValue(true);
});

describe("focusNotificationSession (F7.3 弹出窗口)", () => {
  it("会话不在任何布局时返回 false，不碰任何聚焦路径", async () => {
    findTabBySessionAcrossLayouts.mockReturnValue(null);

    await expect(focusNotificationSession("gone")).resolves.toBe(false);
    expect(focusTab).not.toHaveBeenCalled();
    expect(focusPoppedOutTab).not.toHaveBeenCalled();
  });

  it("未弹出的 tab 直接走主窗口内定位", async () => {
    stubLocation("tab-1");
    isTabPoppedOut.mockReturnValue(false);

    await expect(focusNotificationSession("s-1")).resolves.toBe(true);
    expect(focusPoppedOutTab).not.toHaveBeenCalled();
    expect(focusTab).toHaveBeenCalledWith("tab-1", { switchAppView: true });
  });

  it("已弹出且窗口仍在：聚焦弹出窗口 + 主窗口内对齐，返回 true", async () => {
    stubLocation("tab-1");
    isTabPoppedOut.mockReturnValue(true);
    focusPoppedOutTab.mockResolvedValue(true);

    await expect(focusNotificationSession("s-1")).resolves.toBe(true);
    expect(focusPoppedOutTab).toHaveBeenCalledWith("tab-1");
    expect(focusTab).toHaveBeenCalledWith("tab-1", { switchAppView: true });
    // 窗口还活着就不该回收。
    expect(storeMarkTabReclaimed).not.toHaveBeenCalled();
    expect(serviceMarkTabReclaimed).not.toHaveBeenCalled();
  });

  it("已弹出但窗口已不存在：自愈回收两份状态后退回主窗口内定位", async () => {
    stubLocation("tab-1");
    isTabPoppedOut.mockReturnValue(true);
    focusPoppedOutTab.mockResolvedValue(false);

    await expect(focusNotificationSession("s-1")).resolves.toBe(true);
    // store 弹出态 + service label 映射都要清，否则下次仍以为它弹出着。
    expect(storeMarkTabReclaimed).toHaveBeenCalledWith("tab-1");
    expect(serviceMarkTabReclaimed).toHaveBeenCalledWith("tab-1");
    expect(focusTab).toHaveBeenCalledWith("tab-1", { switchAppView: true });
  });

  it("主窗口内也找不到该 tab 时透传 focusTab 的 false", async () => {
    stubLocation("tab-1");
    isTabPoppedOut.mockReturnValue(false);
    focusTab.mockReturnValue(false);

    await expect(focusNotificationSession("s-1")).resolves.toBe(false);
  });
});
