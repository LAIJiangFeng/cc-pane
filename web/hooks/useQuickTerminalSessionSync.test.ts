import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 隔离被测 hook：只关心它如何管理订阅生命周期，不关心 service 内部怎么连后端。
const subscribeQuickTerminalSession = vi.fn();
vi.mock("@/services/quickTerminalService", () => ({
  subscribeQuickTerminalSession: () => subscribeQuickTerminalSession(),
}));

import { useQuickTerminalSessionSync } from "./useQuickTerminalSessionSync";

describe("useQuickTerminalSessionSync", () => {
  beforeEach(() => {
    subscribeQuickTerminalSession.mockReset();
  });

  it("挂载时建立订阅", async () => {
    const unlisten = vi.fn();
    subscribeQuickTerminalSession.mockResolvedValue(unlisten);

    renderHook(() => useQuickTerminalSessionSync());

    await waitFor(() => expect(subscribeQuickTerminalSession).toHaveBeenCalledTimes(1));
  });

  it("订阅建立后卸载：调用退订函数，不把监听留在主窗口", async () => {
    const unlisten = vi.fn();
    subscribeQuickTerminalSession.mockResolvedValue(unlisten);

    const { unmount } = renderHook(() => useQuickTerminalSessionSync());
    // 等订阅的 then 真正跑完（unlisten 已存进闭包），否则卸载时拿到的是 null。
    await waitFor(() => expect(subscribeQuickTerminalSession).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("竞态：订阅还没 resolve 就卸载，resolve 后立即退订", async () => {
    // 用一个手动可控的 promise，制造「订阅在途时组件已卸载」的窗口。
    let resolveSub: ((fn: () => void) => void) | undefined;
    const unlisten = vi.fn();
    subscribeQuickTerminalSession.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveSub = resolve;
      }),
    );

    const { unmount } = renderHook(() => useQuickTerminalSessionSync());
    // 订阅已在途但还没 resolve，此时卸载：disposed=true，闭包里的 unlisten 仍是 null。
    unmount();
    expect(unlisten).not.toHaveBeenCalled();

    // 订阅迟到 resolve：hook 必须检测到已卸载并立刻退订，否则监听泄漏在主窗口。
    resolveSub?.(unlisten);
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("订阅失败（旧版后端/非 Tauri）只 warn，不向用户抛错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    subscribeQuickTerminalSession.mockRejectedValue(new Error("command not found"));

    const { unmount } = renderHook(() => useQuickTerminalSessionSync());

    await waitFor(() => expect(warn).toHaveBeenCalled());
    // 失败路径下卸载不应再抛（闭包里没有 unlisten 可调）。
    expect(() => unmount()).not.toThrow();
    warn.mockRestore();
  });
});
