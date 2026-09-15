import type { TFunction } from "i18next";
import type {
  SshJumpHost,
  SshMachine,
  SshProxyConfig,
  SshProxyKind,
} from "@/types";

/**
 * 路由编辑器的本地表单状态。
 *
 * 与持久化模型分离：端口用字符串方便输入，开关用布尔，密码输入只在内存里，
 * 绝不进 `SshMachine`。`routeFormToMachineFields` / `routeFormToRequestFields`
 * 负责把它收敛成后端要的形状。
 */
export interface RouteFormState {
  proxyEnabled: boolean;
  proxyKind: SshProxyKind;
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  rememberProxyPassword: boolean;
  proxyPasswordInput: string;
  clearStoredProxyPassword: boolean;

  jumpEnabled: boolean;
  /** reference = 引用已保存机器；inline = 内联 host */
  jumpMode: "reference" | "inline";
  jumpMachineId: string;
  jumpHost: string;
  jumpPort: string;
  jumpUser: string;
  jumpIdentityFile: string;
}

export const emptyRouteForm: RouteFormState = {
  proxyEnabled: false,
  proxyKind: "socks5",
  proxyHost: "",
  proxyPort: "1080",
  proxyUsername: "",
  rememberProxyPassword: false,
  proxyPasswordInput: "",
  clearStoredProxyPassword: false,
  jumpEnabled: false,
  jumpMode: "reference",
  jumpMachineId: "",
  jumpHost: "",
  jumpPort: "22",
  jumpUser: "",
  jumpIdentityFile: "",
};

/** 解析 1-65535 的端口；非法返回 null。 */
export function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number.parseInt(trimmed, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

/** 代理是否需要密码：填了用户名即视为需要。与后端 requires_credentials 一致。 */
export function proxyNeedsCredentials(form: RouteFormState): boolean {
  return form.proxyEnabled && form.proxyUsername.trim().length > 0;
}

/** 从已保存机器还原表单；新建机器返回默认空表单。 */
export function routeFormFromMachine(
  machine: SshMachine | null | undefined,
): RouteFormState {
  if (!machine) return { ...emptyRouteForm };
  const proxy = machine.proxy;
  const jump = machine.jumpHost;
  return {
    proxyEnabled: !!proxy,
    proxyKind: proxy?.kind ?? "socks5",
    proxyHost: proxy?.host ?? "",
    proxyPort: proxy ? String(proxy.port) : emptyRouteForm.proxyPort,
    proxyUsername: proxy?.username ?? "",
    rememberProxyPassword: !!machine.hasStoredProxyPassword,
    proxyPasswordInput: "",
    clearStoredProxyPassword: false,
    jumpEnabled: !!jump,
    jumpMode: jump?.machineId ? "reference" : "inline",
    jumpMachineId: jump?.machineId ?? "",
    jumpHost: jump?.host ?? "",
    // 引用式跳板的端口来自被引用机器，这里只作占位。
    jumpPort: jump ? String(jump.port) : emptyRouteForm.jumpPort,
    jumpUser: jump?.user ?? "",
    jumpIdentityFile: jump?.identityFile ?? "",
  };
}

/** 把表单收敛成 `SshMachine` 的 proxy / jumpHost 字段（不含任何机密）。 */
export function routeFormToMachineFields(form: RouteFormState): {
  proxy?: SshProxyConfig;
  jumpHost?: SshJumpHost;
} {
  const fields: { proxy?: SshProxyConfig; jumpHost?: SshJumpHost } = {};

  if (form.proxyEnabled) {
    const port = parsePort(form.proxyPort);
    const host = form.proxyHost.trim();
    if (host && port !== null) {
      fields.proxy = {
        kind: form.proxyKind,
        host,
        port,
        username: form.proxyUsername.trim() || undefined,
      };
    }
  }

  if (form.jumpEnabled) {
    if (form.jumpMode === "reference") {
      const machineId = form.jumpMachineId.trim();
      if (machineId) {
        // 后端对引用式跳板使用「被引用机器自己」的端口，这里的 port 仅作占位。
        fields.jumpHost = { machineId, port: parsePort(form.jumpPort) ?? 22 };
      }
    } else {
      const host = form.jumpHost.trim();
      const port = parsePort(form.jumpPort);
      if (host && port !== null) {
        fields.jumpHost = {
          host,
          port,
          user: form.jumpUser.trim() || undefined,
          identityFile: form.jumpIdentityFile.trim() || undefined,
        };
      }
    }
  }

  return fields;
}

/** 把表单收敛成 upsert 请求里的代理密码字段。机密只走 request，不进 machine。 */
export function routeFormToRequestFields(
  form: RouteFormState,
  originalMachine?: SshMachine | null,
): {
  rememberProxyPassword: boolean;
  proxyPasswordInput?: string;
  clearStoredProxyPassword: boolean;
} {
  const needs = proxyNeedsCredentials(form);
  const passwordInput = form.proxyPasswordInput.trim();
  return {
    rememberProxyPassword: needs && form.rememberProxyPassword,
    proxyPasswordInput: needs && passwordInput ? form.proxyPasswordInput : undefined,
    // 镜像登录密码的清理逻辑：取消记住、代理不再需要凭据、或显式清除时删凭据。
    clearStoredProxyPassword:
      form.clearStoredProxyPassword ||
      !needs ||
      (needs &&
        !form.rememberProxyPassword &&
        !!originalMachine?.hasStoredProxyPassword),
  };
}

export type RouteTranslate = TFunction<["sidebar", "common"]>;

/**
 * 提交前校验路由表单，返回已本地化的错误消息或 null。
 * 与后端校验保持一致，但提前在 UI 给出友好提示。
 */
export function validateRouteForm(
  form: RouteFormState,
  isEdit: boolean,
  originalMachine: SshMachine | null | undefined,
  t: RouteTranslate,
): string | null {
  if (form.proxyEnabled) {
    if (!form.proxyHost.trim()) {
      return t("ssh.proxy.hostRequired", {
        defaultValue: "Proxy host is required.",
      });
    }
    if (parsePort(form.proxyPort) === null) {
      return t("ssh.proxy.portInvalid", {
        defaultValue: "Proxy port must be 1-65535.",
      });
    }
    // 勾选记住代理密码却没给新密码、也没已存密码：拒绝，避免静默存空。
    if (
      proxyNeedsCredentials(form) &&
      form.rememberProxyPassword &&
      !form.proxyPasswordInput.trim() &&
      !(isEdit && originalMachine?.hasStoredProxyPassword)
    ) {
      return t("ssh.proxy.passwordRequiredToRemember", {
        defaultValue: "Enter a proxy password before enabling remember.",
      });
    }
  }

  if (form.jumpEnabled) {
    if (form.jumpMode === "reference") {
      if (!form.jumpMachineId.trim()) {
        return t("ssh.jump.machineRequired", {
          defaultValue: "Select a jump machine.",
        });
      }
    } else {
      if (!form.jumpHost.trim()) {
        return t("ssh.jump.hostRequired", {
          defaultValue: "Jump host is required.",
        });
      }
      if (parsePort(form.jumpPort) === null) {
        return t("ssh.jump.portInvalid", {
          defaultValue: "Jump port must be 1-65535.",
        });
      }
    }
  }

  return null;
}

/** 路由配置是否相对原机器发生变化（用于禁用「测试」按钮）。 */
export function isRouteFormDirty(
  form: RouteFormState,
  originalMachine: SshMachine | null | undefined,
): boolean {
  if (!originalMachine) {
    // 新建模式：只要开启了代理或跳板就算脏。
    return form.proxyEnabled || form.jumpEnabled;
  }
  const derived = routeFormToMachineFields(form);
  const sameProxy =
    JSON.stringify(derived.proxy ?? null) ===
    JSON.stringify(originalMachine.proxy ?? null);
  const sameJump =
    JSON.stringify(derived.jumpHost ?? null) ===
    JSON.stringify(originalMachine.jumpHost ?? null);
  const rememberChanged =
    form.rememberProxyPassword !== !!originalMachine.hasStoredProxyPassword;
  return (
    !sameProxy ||
    !sameJump ||
    rememberChanged ||
    form.clearStoredProxyPassword ||
    form.proxyPasswordInput.trim().length > 0
  );
}
