import { useCallback, useEffect, useMemo, useState } from "react";
import { useSshMachinesStore } from "@/stores";
import type { SshJumpHost, SshProxyConfig, SshMachine } from "@/types";
import {
  emptyRouteForm,
  isRouteFormDirty,
  routeFormFromMachine,
  routeFormToMachineFields,
  routeFormToRequestFields,
  validateRouteForm,
  type RouteFormState,
  type RouteTranslate,
} from "@/lib/sshRouteForm";

export interface SshRouteFormRequestFields {
  rememberProxyPassword: boolean;
  proxyPasswordInput?: string;
  clearStoredProxyPassword: boolean;
}

export interface UseSshRouteForm {
  form: RouteFormState;
  setField: <K extends keyof RouteFormState>(
    key: K,
    value: RouteFormState[K],
  ) => void;
  reset: () => void;
  /** proxy / jumpHost 字段，并入 `savedMachine`（不含机密） */
  machineFields: { proxy?: SshProxyConfig; jumpHost?: SshJumpHost };
  /** 代理密码字段，并入 upsert 请求（机密只走请求体） */
  requestFields: SshRouteFormRequestFields;
  /** 返回本地化错误消息或 null */
  validate: () => string | null;
  /** 路由相对原机器是否变化（并入 isFormDirty 以禁用「测试」按钮） */
  isDirty: () => boolean;
  /** 已保存机器，供跳板「引用模式」下拉与路由预览使用 */
  machines: SshMachine[];
}

/**
 * SSH 机器对话框的「连接路由」表单状态。
 *
 * 把代理 / 跳板的本地表单与持久化模型解耦：对话框只管 host/port/auth 等基础字段，
 * 这里负责路由字段的还原、收敛、校验与脏检测，全部走 `@/lib/sshRouteForm` 的纯函数，
 * 不联网、不读 keyring、不注册任何新 Tauri 命令。
 */
export function useSshRouteForm(
  open: boolean,
  machine: SshMachine | null | undefined,
  isEdit: boolean,
  t: RouteTranslate,
): UseSshRouteForm {
  const machines = useSshMachinesStore((s) => s.machines);
  const [form, setForm] = useState<RouteFormState>(() =>
    routeFormFromMachine(machine),
  );

  const setField = useCallback(
    <K extends keyof RouteFormState>(key: K, value: RouteFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const reset = useCallback(() => setForm({ ...emptyRouteForm }), []);

  // 与对话框的基础字段同步：打开时按机器还原（null 即空表单），关闭则清空。
  useEffect(() => {
    if (open) {
      setForm(routeFormFromMachine(machine));
    } else {
      setForm({ ...emptyRouteForm });
    }
  }, [open, machine]);

  const machineFields = useMemo(() => routeFormToMachineFields(form), [form]);

  const requestFields = useMemo(
    () => routeFormToRequestFields(form, machine),
    [form, machine],
  );

  const validate = useCallback(
    () => validateRouteForm(form, isEdit, machine, t),
    [form, isEdit, machine, t],
  );

  const isDirty = useCallback(
    () => isRouteFormDirty(form, machine),
    [form, machine],
  );

  return {
    form,
    setField,
    reset,
    machineFields,
    requestFields,
    validate,
    isDirty,
    machines,
  };
}
