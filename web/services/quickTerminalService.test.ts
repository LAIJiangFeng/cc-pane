import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
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
});
