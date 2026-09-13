import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  getQuickTerminalSessionId,
  isQuickTerminalSession,
  useQuickTerminalSessionStore,
} from "./useQuickTerminalSessionStore";

const record = { sessionId: "s-1", projectPath: "/repo", title: "Quick" };

beforeEach(() => {
  // store 是模块级单例，不随 vi.resetModules 重置，逐用例显式清空。
  useQuickTerminalSessionStore.getState().resetForTest();
});

describe("useQuickTerminalSessionStore", () => {
  it("初始无登记", () => {
    expect(useQuickTerminalSessionStore.getState().session).toBeNull();
    expect(getQuickTerminalSessionId()).toBeNull();
  });

  it("setSession 写入登记，getQuickTerminalSessionId 同步读出 id", () => {
    useQuickTerminalSessionStore.getState().setSession(record);

    expect(useQuickTerminalSessionStore.getState().session).toEqual(record);
    expect(getQuickTerminalSessionId()).toBe("s-1");
  });

  it("setSession(null) 清空登记", () => {
    useQuickTerminalSessionStore.getState().setSession(record);
    useQuickTerminalSessionStore.getState().setSession(null);

    expect(useQuickTerminalSessionStore.getState().session).toBeNull();
    expect(getQuickTerminalSessionId()).toBeNull();
  });

  it("传入相同引用时不触发订阅者重渲染（补查路径每次都 set，不能空转一轮）", () => {
    useQuickTerminalSessionStore.getState().setSession(record);
    const subscriber = vi.fn();
    // 只订阅 session 切片：值不变就不该回调。
    const unsub = useQuickTerminalSessionStore.subscribe(subscriber);

    useQuickTerminalSessionStore.getState().setSession(record);

    expect(subscriber).not.toHaveBeenCalled();
    unsub();
  });

  it("传入不同引用（内容相同）时仍会更新订阅者", () => {
    useQuickTerminalSessionStore.getState().setSession(record);
    const subscriber = vi.fn();
    const unsub = useQuickTerminalSessionStore.subscribe(subscriber);

    useQuickTerminalSessionStore.getState().setSession({ ...record });

    expect(subscriber).toHaveBeenCalled();
    unsub();
  });

  describe("isQuickTerminalSession", () => {
    it("登记的会话命中", () => {
      useQuickTerminalSessionStore.getState().setSession(record);
      expect(isQuickTerminalSession("s-1")).toBe(true);
    });

    it("未登记的会话不命中", () => {
      useQuickTerminalSessionStore.getState().setSession(record);
      expect(isQuickTerminalSession("s-other")).toBe(false);
    });

    it("无登记时任何 id 都不命中", () => {
      expect(isQuickTerminalSession("s-1")).toBe(false);
    });

    it("null / undefined / 空串都安全返回 false（不抛、不误判）", () => {
      useQuickTerminalSessionStore.getState().setSession(record);
      expect(isQuickTerminalSession(null)).toBe(false);
      expect(isQuickTerminalSession(undefined)).toBe(false);
      expect(isQuickTerminalSession("")).toBe(false);
    });
  });
});
