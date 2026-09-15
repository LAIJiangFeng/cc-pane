import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

const originalTauriInternals = window.__TAURI_INTERNALS__;

async function importService() {
  return import("./quickTerminalService");
}

describe("quickTerminalService", () => {
  beforeEach(() => {
    vi.resetModules();
    resetTauriInvoke();
    // listen 的 mock 由 setup 统一提供，resetTauriInvoke 不管它；
    // 不清的话上个订阅用例的调用记录会泄到 Web 用例的 not.toHaveBeenCalled。
    (listen as ReturnType<typeof vi.fn>).mockClear();
    window.__TAURI_INTERNALS__ = originalTauriInternals ?? {};
  });

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalTauriInternals;
  });

  it("label 与后端 QUICK_TERMINAL_LABEL 一致", async () => {
    const service = await importService();
    expect(service.QUICK_TERMINAL_LABEL).toBe("popup-quick-terminal");
  });

  describe("toggleQuickTerminal", () => {
    it("Tauri 运行时调用 toggle_quick_terminal", async () => {
      const service = await importService();
      mockTauriInvoke({ toggle_quick_terminal: undefined });

      await service.toggleQuickTerminal();

      expect(invoke).toHaveBeenCalledWith("toggle_quick_terminal");
    });

    it("Web 运行时静默返回，不调用 invoke", async () => {
      const service = await importService();
      delete window.__TAURI_INTERNALS__;

      await expect(service.toggleQuickTerminal()).resolves.toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe("hideQuickTerminal", () => {
    it("Tauri 运行时调用 hide_quick_terminal", async () => {
      const service = await importService();
      mockTauriInvoke({ hide_quick_terminal: undefined });

      await service.hideQuickTerminal();

      expect(invoke).toHaveBeenCalledWith("hide_quick_terminal");
    });

    it("Web 运行时静默返回", async () => {
      const service = await importService();
      delete window.__TAURI_INTERNALS__;

      await expect(service.hideQuickTerminal()).resolves.toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe("updateQuickTerminalShortcut", () => {
    it("以 camelCase 传 oldShortcut/newShortcut", async () => {
      const service = await importService();
      mockTauriInvoke({ quick_terminal_update_shortcut: undefined });

      await service.updateQuickTerminalShortcut("Ctrl+Alt+Q", "Ctrl+Alt+T");

      expect(invoke).toHaveBeenCalledWith("quick_terminal_update_shortcut", {
        oldShortcut: "Ctrl+Alt+Q",
        newShortcut: "Ctrl+Alt+T",
      });
    });

    it("Web 运行时静默返回", async () => {
      const service = await importService();
      delete window.__TAURI_INTERNALS__;

      await expect(
        service.updateQuickTerminalShortcut("A", "B"),
      ).resolves.toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe("isQuickTerminalTabData", () => {
    it("mode === 'quick' 判定为快捷终端", async () => {
      const service = await importService();
      expect(service.isQuickTerminalTabData({ mode: "quick" })).toBe(true);
    });

    it("普通 popup / 缺 mode / null / undefined 均不是快捷终端", async () => {
      const service = await importService();
      expect(service.isQuickTerminalTabData({ mode: undefined })).toBe(false);
      expect(service.isQuickTerminalTabData({})).toBe(false);
      expect(service.isQuickTerminalTabData(null)).toBe(false);
      expect(service.isQuickTerminalTabData(undefined)).toBe(false);
    });
  });

  describe("reportQuickTerminalSession", () => {
    it("Tauri 运行时上报 set_quick_terminal_session（camelCase）并写镜像", async () => {
      const service = await importService();
      mockTauriInvoke({ set_quick_terminal_session: undefined });

      await service.reportQuickTerminalSession({
        sessionId: "s-1",
        projectPath: "/repo",
        title: "Quick",
      });

      expect(invoke).toHaveBeenCalledWith("set_quick_terminal_session", {
        sessionId: "s-1",
        projectPath: "/repo",
        title: "Quick",
      });
      expect(service.getMirroredQuickTerminalSession()).toEqual({
        sessionId: "s-1",
        projectPath: "/repo",
        title: "Quick",
      });
    });

    it("缺 title 时以 null 上报", async () => {
      const service = await importService();
      mockTauriInvoke({ set_quick_terminal_session: undefined });

      await service.reportQuickTerminalSession({ sessionId: "s-1", projectPath: "/repo" });

      expect(invoke).toHaveBeenCalledWith("set_quick_terminal_session", {
        sessionId: "s-1",
        projectPath: "/repo",
        title: null,
      });
    });

    it("上报 null = 会话结束：清镜像并以三个 null 通知后端", async () => {
      const service = await importService();
      mockTauriInvoke({ set_quick_terminal_session: undefined });
      await service.reportQuickTerminalSession({ sessionId: "s-1", projectPath: "/repo" });

      await service.reportQuickTerminalSession(null);

      expect(invoke).toHaveBeenLastCalledWith("set_quick_terminal_session", {
        sessionId: null,
        projectPath: null,
        title: null,
      });
      expect(service.getMirroredQuickTerminalSession()).toBeNull();
    });

    it("Web 运行时只写镜像不调 invoke（本窗口立即可见，后端登记交给广播）", async () => {
      const service = await importService();
      delete window.__TAURI_INTERNALS__;

      await service.reportQuickTerminalSession({ sessionId: "s-1", projectPath: "/repo" });

      expect(invoke).not.toHaveBeenCalled();
      expect(service.getMirroredQuickTerminalSession()).toMatchObject({ sessionId: "s-1" });
    });
  });

  describe("refreshQuickTerminalSession", () => {
    it("Tauri 运行时从后端补查并刷新镜像", async () => {
      const service = await importService();
      mockTauriInvoke({
        get_quick_terminal_session: { sessionId: "s-9", projectPath: "/x", title: "T" },
      });

      const result = await service.refreshQuickTerminalSession();

      expect(invoke).toHaveBeenCalledWith("get_quick_terminal_session");
      expect(result).toEqual({ sessionId: "s-9", projectPath: "/x", title: "T" });
      expect(service.getMirroredQuickTerminalSession()).toEqual(result);
    });

    it("后端命令不可用（旧版无此命令）时保持现有镜像不动，不抛错", async () => {
      const service = await importService();
      mockTauriInvoke({ set_quick_terminal_session: undefined });
      await service.reportQuickTerminalSession({ sessionId: "s-1", projectPath: "/repo" });

      // get_quick_terminal_session 未注册 -> invoke reject，模拟旧版后端。
      const result = await service.refreshQuickTerminalSession();

      expect(result).toEqual({ sessionId: "s-1", projectPath: "/repo" });
      expect(service.getMirroredQuickTerminalSession()).toMatchObject({ sessionId: "s-1" });
    });

    it("Web 运行时直接返回当前镜像，不调 invoke", async () => {
      const service = await importService();
      delete window.__TAURI_INTERNALS__;

      const result = await service.refreshQuickTerminalSession();

      expect(invoke).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe("focusQuickTerminalWindow", () => {
    it("Tauri 运行时调 focus_popup_terminal_window（带 label）并透传布尔结果", async () => {
      const service = await importService();
      mockTauriInvoke({ focus_popup_terminal_window: true });

      await expect(service.focusQuickTerminalWindow()).resolves.toBe(true);
      expect(invoke).toHaveBeenCalledWith("focus_popup_terminal_window", {
        label: "popup-quick-terminal",
      });
    });

    it("窗口已不存在（后端返回 false）时如实回 false", async () => {
      const service = await importService();
      mockTauriInvoke({ focus_popup_terminal_window: false });

      await expect(service.focusQuickTerminalWindow()).resolves.toBe(false);
    });

    it("Web 运行时返回 false，不调 invoke", async () => {
      const service = await importService();
      delete window.__TAURI_INTERNALS__;

      await expect(service.focusQuickTerminalWindow()).resolves.toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe("destroyQuickTerminal", () => {
    it("Tauri 运行时调 destroy_quick_terminal", async () => {
      const service = await importService();
      mockTauriInvoke({ destroy_quick_terminal: undefined });

      await service.destroyQuickTerminal();

      expect(invoke).toHaveBeenCalledWith("destroy_quick_terminal");
    });

    it("Web 运行时静默返回", async () => {
      const service = await importService();
      delete window.__TAURI_INTERNALS__;

      await expect(service.destroyQuickTerminal()).resolves.toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe("subscribeQuickTerminalSession", () => {
    it("订阅变更事件：handler 收到登记即写镜像，并立即补查一次", async () => {
      const service = await importService();
      let captured: ((event: { payload: unknown }) => void) | undefined;
      const unlisten = vi.fn();
      (listen as ReturnType<typeof vi.fn>).mockImplementation((_event, handler) => {
        captured = handler;
        return Promise.resolve(unlisten);
      });
      // subscribe 末尾会 refresh 一次，需注册 get 命令。
      mockTauriInvoke({ get_quick_terminal_session: null });

      const result = await service.subscribeQuickTerminalSession();

      expect(listen).toHaveBeenCalledWith(
        "quick-terminal-session-changed",
        expect.any(Function),
      );
      // 订阅建立时立即补查（快捷终端可能先开、主窗口后重建）。
      expect(invoke).toHaveBeenCalledWith("get_quick_terminal_session");
      expect(result).toBe(unlisten);

      // 模拟后端广播一条登记。
      captured?.({ payload: { sessionId: "s-5", projectPath: "/p", title: "T" } });
      expect(service.getMirroredQuickTerminalSession()).toEqual({
        sessionId: "s-5",
        projectPath: "/p",
        title: "T",
      });
    });

    it("handler 收到 null（会话退出/窗口销毁）时清空镜像", async () => {
      const service = await importService();
      let captured: ((event: { payload: unknown }) => void) | undefined;
      (listen as ReturnType<typeof vi.fn>).mockImplementation((_event, handler) => {
        captured = handler;
        return Promise.resolve(() => {});
      });
      mockTauriInvoke({
        get_quick_terminal_session: { sessionId: "s-1", projectPath: "/p" },
      });

      await service.subscribeQuickTerminalSession();
      // refresh 已写入 s-1。
      expect(service.getMirroredQuickTerminalSession()).toMatchObject({ sessionId: "s-1" });

      captured?.({ payload: null });
      expect(service.getMirroredQuickTerminalSession()).toBeNull();
    });

    it("Web 运行时不调 listen/invoke，但仍返回可用的退订函数", async () => {
      const service = await importService();
      delete window.__TAURI_INTERNALS__;

      const unlisten = await service.subscribeQuickTerminalSession();

      expect(listen).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(typeof unlisten).toBe("function");
      expect(() => unlisten()).not.toThrow();
    });
  });
});
