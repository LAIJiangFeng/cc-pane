/** SSH 认证方式 */
export type AuthMethod = "password" | "key" | "agent";

/** 代理协议类型 */
export type SshProxyKind = "socks5" | "http";

/**
 * 每主机代理配置。
 * 仅含连接所需的非机密字段；代理密码存 keyring，绝不进此模型。
 */
export interface SshProxyConfig {
  kind: SshProxyKind;
  host: string;
  port: number;
  /** 配置了用户名即视为该代理需要密码认证 */
  username?: string;
}

/**
 * 跳板机配置，二选一：
 * - `machineId`：引用已保存的 SSH 机器，复用其认证方式与凭据
 * - 内联 `host`：直接用 identityFile（key）或 ssh-agent 认证
 */
export interface SshJumpHost {
  machineId?: string;
  host?: string;
  port: number;
  user?: string;
  identityFile?: string;
}

/** SSH 机器配置 — 独立实体，可被多个工作空间引用 */
export interface SshMachine {
  id: string;
  name: string;
  host: string;
  port: number;
  user?: string;
  authMethod: AuthMethod;
  identityFile?: string;
  description?: string;
  /** 默认远端工作目录（连接时自动 cd，为空则用 ~） */
  defaultPath?: string;
  tags: string[];
  /** 每主机代理；为空表示直连 */
  proxy?: SshProxyConfig;
  /** 跳板机；为空表示不经过跳板 */
  jumpHost?: SshJumpHost;
  hasStoredPassword?: boolean;
  /** keyring 中是否已存代理密码（仅代理需要凭据时有意义） */
  hasStoredProxyPassword?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SshMachineUpsertRequest {
  machine: SshMachine;
  rememberPassword: boolean;
  passwordInput?: string;
  clearStoredPassword: boolean;
  /** 记住代理密码到 keyring。可选：后端 serde(default) 视为 false，保持旧调用方兼容。 */
  rememberProxyPassword?: boolean;
  proxyPasswordInput?: string;
  /** 清除已存代理密码。可选：后端 serde(default) 视为 false。 */
  clearStoredProxyPassword?: boolean;
}

/** SSH 连通性检测结果 */
export interface SshConnectivityResult {
  reachable: boolean;
  message: string;
  latencyMs: number | null;
}
