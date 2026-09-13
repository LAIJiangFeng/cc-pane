import { create } from "zustand";

import type { QuickTerminalSessionRecord } from "@/services/quickTerminalService";

/**
 * 快捷终端会话登记的前端镜像（docs/105 F1.4）。
 *
 * **为什么是 store 而不是模块变量**：通知卡片用 `useMemo` 算定位，只在挂载时算一次。
 * 登记是后端异步广播来的，模块变量变了组件不会重渲染 → 卡片仍认为「定位不到」。
 * 做成 store 后卡片能订阅，快捷终端一开会话，历史里的通知就长出「聚焦会话」按钮。
 *
 * 同步读用 `getState()`（通知定位在 store 的同步取值路径里被调用，不能 await）。
 */
interface QuickTerminalSessionStore {
  /** 当前住在快捷终端窗口里的会话；null = 没有（窗口销毁 / 会话退出） */
  session: QuickTerminalSessionRecord | null;
  setSession(session: QuickTerminalSessionRecord | null): void;
  resetForTest(): void;
}

export const useQuickTerminalSessionStore = create<QuickTerminalSessionStore>((set) => ({
  session: null,

  setSession(session) {
    // 引用相同就别 set：后端只在值真变时广播，但补查路径每次都会调，
    // 无意义的 set 会让所有订阅者重渲染一轮。
    set((state) => (state.session === session ? state : { session }));
  },

  resetForTest() {
    set({ session: null });
  },
}));

/** 同步读当前登记的会话 id（通知定位回退用） */
export function getQuickTerminalSessionId(): string | null {
  return useQuickTerminalSessionStore.getState().session?.sessionId ?? null;
}

/** 同步判断某会话是否住在快捷终端窗口里 */
export function isQuickTerminalSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return useQuickTerminalSessionStore.getState().session?.sessionId === sessionId;
}
