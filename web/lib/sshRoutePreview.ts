import type { SshMachine, SshProxyConfig, SshProxyKind } from "@/types";

/**
 * 路由预览的一跳。顺序与后端 `open_routed_stream` 完全一致：
 * 代理（若有）→ 跳板（若有）→ 目标。
 */
export type SshRouteHopType = "proxy" | "jump" | "target";

export interface SshRouteHop {
  type: SshRouteHopType;
  /** 形如 `proxy.example:1080` 的端点，IPv6 由后端 format_address 处理，这里只拼 host:port */
  endpoint: string;
  /** 仅 type === "proxy" 时有值 */
  proxyKind?: SshProxyKind;
  /** 跳板引用了已保存机器时，显示该机器名 */
  machineName?: string;
}

export type SshRouteWarningCode = "jumpMachineMissing" | "nestedJumpUnsupported";

export interface SshRouteWarning {
  code: SshRouteWarningCode;
  machineId: string;
}

export interface SshRoutePreview {
  hops: SshRouteHop[];
  usesProxy: boolean;
  usesJump: boolean;
  /** 直连：既无代理也无跳板 */
  direct: boolean;
  warnings: SshRouteWarning[];
}

function endpoint(host: string, port: number): string {
  return `${host}:${port}`;
}

function proxyHop(proxy: SshProxyConfig): SshRouteHop {
  return {
    type: "proxy",
    endpoint: endpoint(proxy.host, proxy.port),
    proxyKind: proxy.kind,
  };
}

/**
 * 纯函数：根据一台机器（草稿或已保存）与全部已保存机器，推导连接路由。
 *
 * 必须与 Rust `SshConnectionService::open_routed_stream` /
 * `connect_jump_session` / `connect_referenced_jump` 的行为逐条对应：
 * - 跳板优先于代理；
 * - 内联跳板复用「所属主机」的代理去够到跳板机；
 * - 引用式跳板用「被引用机器自己」的代理，且不支持嵌套跳板；
 * - 都没有则直连。
 *
 * 不联网、不读 keyring、不调用任何 Tauri 命令，因此可单测且无需注册新命令。
 */
export function buildSshRoutePreview(
  machine: Pick<SshMachine, "host" | "port" | "proxy" | "jumpHost">,
  allMachines: readonly SshMachine[],
): SshRoutePreview {
  const hops: SshRouteHop[] = [];
  const warnings: SshRouteWarning[] = [];
  const jump = machine.jumpHost;
  const proxy = machine.proxy;

  if (jump) {
    const referencedId = jump.machineId?.trim();
    if (referencedId) {
      // 引用式跳板：解析被引用机器自己的路由。
      const jumpMachine = allMachines.find((m) => m.id === referencedId);
      if (!jumpMachine) {
        warnings.push({ code: "jumpMachineMissing", machineId: referencedId });
      } else {
        if (jumpMachine.jumpHost) {
          // 后端在 connect_referenced_jump 里显式拒绝嵌套跳板。
          warnings.push({
            code: "nestedJumpUnsupported",
            machineId: referencedId,
          });
        }
        // 用「跳板机自己」的代理，而非所属主机的代理。
        if (jumpMachine.proxy) {
          hops.push(proxyHop(jumpMachine.proxy));
        }
        hops.push({
          type: "jump",
          endpoint: endpoint(jumpMachine.host, jumpMachine.port),
          machineName: jumpMachine.name,
        });
      }
    } else if (jump.host?.trim()) {
      // 内联跳板：复用所属主机的代理去够到跳板机。
      if (proxy) {
        hops.push(proxyHop(proxy));
      }
      hops.push({
        type: "jump",
        endpoint: endpoint(jump.host.trim(), jump.port),
      });
    }
  } else if (proxy) {
    hops.push(proxyHop(proxy));
  }

  hops.push({ type: "target", endpoint: endpoint(machine.host, machine.port) });

  const usesProxy = hops.some((hop) => hop.type === "proxy");
  const usesJump = hops.some((hop) => hop.type === "jump");

  return {
    hops,
    usesProxy,
    usesJump,
    direct: !usesProxy && !usesJump,
    warnings,
  };
}
