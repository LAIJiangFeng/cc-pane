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
const adoptSession = vi.fn();
const setSessionLeaseReadOnly = vi.fn();
vi.mock("@/stores", () => ({
  usePanesStore: {
    getState: () => ({
      findTabBySessionAcrossLayouts,
      isTabPoppedOut,
      markTabReclaimed: storeMarkTabReclaimed,
      adoptSession,
      setSessionLeaseReadOnly,
    }),
  },
  useOrchestratorStore: { getState: () => ({ setSelectedTaskId: vi.fn() }) },
  useActivityBarStore: { getState: () => ({ openOrchestrationOverlay: vi.fn() }) },
}));

// 快捷终端镜像登记（F1.4）：定位回退与接管元信息都读它。
const mirroredRecord: { current: QuickTerminalRecordStub | null } = { current: null };
interface QuickTerminalRecordStub {
  sessionId: string;
  projectPath: string;
  title?: string;
}
const focusQuickTerminalWindow = vi.fn();
const destroyQuickTerminal = vi.fn();
vi.mock("@/services/quickTerminalService", () => ({
  focusQuickTerminalWindow: (...args: unknown[]) => focusQuickTerminalWindow(...args),
  destroyQuickTerminal: (...args: unknown[]) => destroyQuickTerminal(...args),
  getMirroredQuickTerminalSession: () => mirroredRecord.current,
}));

// 写租约 claim：接管前必须先拿到，拿不到就不敢在主窗口 reattach 这条 PTY。
const serviceAdoptSession = vi.fn();
const releaseSession = vi.fn();
vi.mock("@/services/terminalService", () => ({
  terminalService: {
    adoptSession: (...args: unknown[]) => serviceAdoptSession(...args),
    releaseSession: (...args: unknown[]) => releaseSession(...args),
  },
}));

// 活会话状态缓存：接管前要 markSessionLive，否则主窗口会 relaunch 出一条重复 PTY。
const markSessionLive = vi.fn();
vi.mock("@/stores/useTerminalStatusStore", () => ({
  useTerminalStatusStore: { getState: () => ({ markSessionLive }) },
}));

const toastErr = vi.fn();
const toastOk = vi.fn();
vi.mock("@/lib/feedback", () => ({
  toastErr: (...args: unknown[]) => toastErr(...args),
  toastOk: (...args: unknown[]) => toastOk(...args),
}));

import {
  adoptQuickTerminalSession,
  focusNotificationSession,
  handleAdoptQuickTerminal,
  locateNotificationSession,
} from "./notificationActions";
import { useQuickTerminalSessionStore } from "@/stores/useQuickTerminalSessionStore";

function stubLocation(tabId: string) {
  findTabBySessionAcrossLayouts.mockReturnValue({
    tab: { id: tabId },
    panel: { id: "pane-1" },
    tree: {},
    layoutName: "Layout A",
    layoutId: "layout-a",
  });
}

/**
 * 同时驱动登记的两个读取口：
 * - `isQuickTerminalSession`（定位回退）读的是真 store，本文件没 mock 它；
 * - `getMirroredQuickTerminalSession`（接管取 projectPath/title）被 mock 成读 `mirroredRecord`。
 * 两处必须一起设，否则用例里很容易出现「定位得到但取不到元信息」这种生产环境不会出现的状态。
 */
function stubQuickTerminalSession(record: QuickTerminalRecordStub | null): void {
  mirroredRecord.current = record;
  useQuickTerminalSessionStore.getState().setSession(record);
}

beforeEach(() => {
  vi.clearAllMocks();
  focusTab.mockReturnValue(true);
  mirroredRecord.current = null;
  useQuickTerminalSessionStore.getState().resetForTest();
  // 默认走 happy path，各用例只覆盖自己要验的那一段。
  focusQuickTerminalWindow.mockResolvedValue(true);
  serviceAdoptSession.mockResolvedValue(true);
  releaseSession.mockResolvedValue(undefined);
  destroyQuickTerminal.mockResolvedValue(undefined);
  adoptSession.mockReturnValue("tab-adopted");
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

describe("locateNotificationSession", () => {
  it("布局内命中时回布局定位（布局名 + 窗格序号）", () => {
    findTabBySessionAcrossLayouts.mockReturnValue({
      tab: { id: "tab-1" },
      panel: { id: "pane-1" },
      tree: { type: "panel", id: "pane-1", tabs: [] },
      layoutName: "Layout A",
      layoutId: "layout-a",
    });

    expect(locateNotificationSession("s-1")).toMatchObject({
      kind: "layout",
      layoutName: "Layout A",
    });
  });

  it("跨布局查不到但住在快捷终端时回退到 quickTerminal", () => {
    findTabBySessionAcrossLayouts.mockReturnValue(null);
    stubQuickTerminalSession({ sessionId: "quick-1", projectPath: "/repo" });

    expect(locateNotificationSession("quick-1")).toEqual({ kind: "quickTerminal" });
  });

  it("两边都查不到时返回 null（UI 不渲染定位段）", () => {
    findTabBySessionAcrossLayouts.mockReturnValue(null);
    stubQuickTerminalSession({ sessionId: "quick-1", projectPath: "/repo" });

    // 快捷终端里住的是别的会话，这条通知的会话谁也不认。
    expect(locateNotificationSession("s-other")).toBeNull();
  });

  it("布局优先于快捷终端：已接管的会话走正常布局路径", () => {
    findTabBySessionAcrossLayouts.mockReturnValue({
      tab: { id: "tab-1" },
      panel: { id: "pane-1" },
      tree: { type: "panel", id: "pane-1", tabs: [] },
      layoutName: "Layout A",
      layoutId: "layout-a",
    });
    // 登记还没被后端清掉时的共存态：此时不能再把人引到快捷窗口。
    stubQuickTerminalSession({ sessionId: "s-1", projectPath: "/repo" });

    expect(locateNotificationSession("s-1")?.kind).toBe("layout");
  });

  it("无 sessionId 直接返回 null", () => {
    expect(locateNotificationSession(undefined)).toBeNull();
    expect(findTabBySessionAcrossLayouts).not.toHaveBeenCalled();
  });
});

describe("focusNotificationSession (F1.4 快捷终端回退)", () => {
  it("会话住在快捷终端时唤出那个窗口", async () => {
    findTabBySessionAcrossLayouts.mockReturnValue(null);
    stubQuickTerminalSession({ sessionId: "quick-1", projectPath: "/repo" });

    await expect(focusNotificationSession("quick-1")).resolves.toBe(true);
    expect(focusQuickTerminalWindow).toHaveBeenCalled();
    // 它不在任何布局里，不该去切分屏。
    expect(focusTab).not.toHaveBeenCalled();
  });

  it("快捷窗口已不存在（登记过期）时诚实返回 false", async () => {
    findTabBySessionAcrossLayouts.mockReturnValue(null);
    stubQuickTerminalSession({ sessionId: "quick-1", projectPath: "/repo" });
    focusQuickTerminalWindow.mockResolvedValue(false);

    await expect(focusNotificationSession("quick-1")).resolves.toBe(false);
  });

  it("布局内有会话时不走快捷终端回退", async () => {
    stubLocation("tab-1");
    isTabPoppedOut.mockReturnValue(false);

    await focusNotificationSession("s-1");

    expect(focusQuickTerminalWindow).not.toHaveBeenCalled();
    expect(focusTab).toHaveBeenCalledWith("tab-1", { switchAppView: true });
  });
});

describe("adoptQuickTerminalSession (F1.4 在主窗口打开)", () => {
  const record: QuickTerminalRecordStub = {
    sessionId: "quick-1",
    projectPath: "/repo/app",
    title: "Quick Terminal",
  };

  it("成功路径：claim → markLive → 建 tab → 清租约 → 销毁快捷窗口 → 聚焦", async () => {
    stubQuickTerminalSession(record);

    await expect(adoptQuickTerminalSession("quick-1")).resolves.toBe("adopted");

    // 写租约先拿，否则主窗口无权 reattach 这条 PTY。
    expect(serviceAdoptSession).toHaveBeenCalledWith("quick-1");
    // markLive 必须发生在建 tab 之前，否则 TerminalView 读不到活会话会 relaunch 出重复 PTY。
    expect(markSessionLive).toHaveBeenCalledWith("quick-1");
    expect(markSessionLive.mock.invocationCallOrder[0]).toBeLessThan(
      adoptSession.mock.invocationCallOrder[0],
    );
    // projectPath/title 来自登记项（这条会话不进 savedSessions，别处查不到它的 cwd）。
    expect(adoptSession).toHaveBeenCalledWith("quick-1", {
      projectPath: "/repo/app",
      cliTool: "none",
      customTitle: "Quick Terminal",
    });
    expect(setSessionLeaseReadOnly).toHaveBeenCalledWith("quick-1", false);
    // 主窗口已落地才撤快捷窗口；销毁只关窗，不杀 PTY。
    expect(destroyQuickTerminal).toHaveBeenCalled();
    expect(focusTab).toHaveBeenCalledWith("tab-adopted", { switchAppView: true });
    expect(releaseSession).not.toHaveBeenCalled();
  });

  it("登记已失效 / 会话不匹配时不接管（没有 projectPath 就不建 tab）", async () => {
    stubQuickTerminalSession({ ...record, sessionId: "quick-other" });

    await expect(adoptQuickTerminalSession("quick-1")).resolves.toBe("not-found");

    expect(serviceAdoptSession).not.toHaveBeenCalled();
    expect(adoptSession).not.toHaveBeenCalled();
    expect(destroyQuickTerminal).not.toHaveBeenCalled();
  });

  it("完全没有登记时也回 not-found", async () => {
    stubQuickTerminalSession(null);

    await expect(adoptQuickTerminalSession("quick-1")).resolves.toBe("not-found");
    expect(adoptSession).not.toHaveBeenCalled();
  });

  it("claim 被拒时不建 tab，也不销毁快捷窗口", async () => {
    stubQuickTerminalSession(record);
    serviceAdoptSession.mockResolvedValue(false);

    await expect(adoptQuickTerminalSession("quick-1")).resolves.toBe("claim-failed");

    expect(markSessionLive).not.toHaveBeenCalled();
    expect(adoptSession).not.toHaveBeenCalled();
    // 接管没成，用户还得继续在快捷窗口里干活。
    expect(destroyQuickTerminal).not.toHaveBeenCalled();
  });

  it("claim 报错（IPC 异常）同样当 claim-failed，不抛给用户", async () => {
    stubQuickTerminalSession(record);
    serviceAdoptSession.mockRejectedValue(new Error("daemon down"));

    await expect(adoptQuickTerminalSession("quick-1")).resolves.toBe("claim-failed");
    expect(adoptSession).not.toHaveBeenCalled();
  });

  it("建 tab 失败时释放写租约，且不销毁快捷窗口（否则用户两头落空）", async () => {
    stubQuickTerminalSession(record);
    adoptSession.mockReturnValue(null);

    await expect(adoptQuickTerminalSession("quick-1")).resolves.toBe("adopt-failed");

    expect(releaseSession).toHaveBeenCalledWith("quick-1");
    expect(destroyQuickTerminal).not.toHaveBeenCalled();
    expect(focusTab).not.toHaveBeenCalled();
  });

  it("释放租约失败也不抛：它 30 秒后自动过期，不值得阻断", async () => {
    stubQuickTerminalSession(record);
    adoptSession.mockReturnValue(null);
    releaseSession.mockRejectedValue(new Error("release failed"));

    await expect(adoptQuickTerminalSession("quick-1")).resolves.toBe("adopt-failed");
  });

  it("销毁快捷窗口失败不影响接管结果：tab 已可用", async () => {
    stubQuickTerminalSession(record);
    destroyQuickTerminal.mockRejectedValue(new Error("window gone"));

    await expect(adoptQuickTerminalSession("quick-1")).resolves.toBe("adopted");
    expect(focusTab).toHaveBeenCalledWith("tab-adopted", { switchAppView: true });
  });
});

describe("handleAdoptQuickTerminal", () => {
  // t 是纯透传的键名拼接器，这里只关心调了哪个键，不关心真实文案。
  const t = ((key: string) => key) as never;

  it("成功：ok toast + 返回 true（调用方据此 dismiss 卡片）", async () => {
    stubQuickTerminalSession({ sessionId: "quick-1", projectPath: "/repo" });

    await expect(handleAdoptQuickTerminal("quick-1", t)).resolves.toBe(true);
    expect(toastOk).toHaveBeenCalled();
    expect(toastErr).not.toHaveBeenCalled();
  });

  it("失败：err toast + 返回 false（卡片要留着让用户重试）", async () => {
    stubQuickTerminalSession(null);

    await expect(handleAdoptQuickTerminal("quick-1", t)).resolves.toBe(false);
    expect(toastErr).toHaveBeenCalled();
    expect(toastOk).not.toHaveBeenCalled();
  });

  it("无 sessionId 时直接 false，不弹 toast", async () => {
    await expect(handleAdoptQuickTerminal(undefined, t)).resolves.toBe(false);
    expect(toastErr).not.toHaveBeenCalled();
    expect(toastOk).not.toHaveBeenCalled();
    expect(serviceAdoptSession).not.toHaveBeenCalled();
  });
});
