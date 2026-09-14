use serde::{Deserialize, Serialize};

/// SSH 认证方式
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    Password,
    #[default]
    Key,
    Agent,
}

/// 代理协议类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshProxyKind {
    Socks5,
    Http,
}

impl SshProxyKind {
    /// 稳定标识符，用于日志、UI 预览与配置解析。
    pub fn as_str(self) -> &'static str {
        match self {
            SshProxyKind::Socks5 => "socks5",
            SshProxyKind::Http => "http",
        }
    }
}

/// 每主机代理配置。
///
/// 只保存连接所需的非机密字段；代理密码一律存 keyring，
/// 既不落盘也不进内存模型，避免被序列化或写进日志。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshProxyConfig {
    pub kind: SshProxyKind,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

impl SshProxyConfig {
    /// 是否需要代理凭据（配置了用户名即视为需要密码认证）。
    pub fn requires_credentials(&self) -> bool {
        self.username
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    }
}

/// 跳板机配置。
///
/// 两种形式二选一：
/// - `machine_id`：引用已保存的 SSH 机器，复用其认证方式与 keyring 凭据。
/// - 内联 `host`：直接用 `identity_file`（key）或 ssh-agent 认证。
///
/// 只支持单层跳板。被引用的跳板机若自身还配了跳板，连接时会返回明确错误。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshJumpHost {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
}

impl SshJumpHost {
    /// 是否走「引用已保存机器」的形式。
    pub fn uses_machine_reference(&self) -> bool {
        self.machine_id
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    }
}

/// SSH 机器配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshMachine {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 默认远端工作目录（连接时自动 cd，为空则用 ~）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_path: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 每主机代理（可选）。为空表示直连，旧配置自动兼容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<SshProxyConfig>,
    /// 跳板机（可选）。为空表示直连，旧配置自动兼容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jump_host: Option<SshJumpHost>,
    /// 运行时标志（keyring 实时查询结果），不落盘；序列化时 false 跳过，
    /// true 必须发给前端——机器列表靠它决定是否弹密码框。
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_stored_password: bool,
    /// 运行时标志：keyring 中是否存有该主机的代理密码。语义同上，不落盘。
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_stored_proxy_password: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl SshMachine {
    /// 该机器是否配置了非直连链路（代理或跳板）。
    ///
    /// 这类机器必须走内嵌终端：系统 `ssh` 回退不会带 ProxyCommand / -J，
    /// 静默回退会绕过代理，属于安全相关的正确性问题。
    pub fn uses_routed_connection(&self) -> bool {
        self.proxy.is_some() || self.jump_host.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshMachineUpsertRequest {
    pub machine: SshMachine,
    #[serde(default)]
    pub remember_password: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password_input: Option<String>,
    #[serde(default)]
    pub clear_stored_password: bool,
    /// 是否把代理密码写入系统 keyring。
    #[serde(default)]
    pub remember_proxy_password: bool,
    /// 代理密码明文，仅存在于请求生命周期内，绝不落盘或记日志。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_password_input: Option<String>,
    #[serde(default)]
    pub clear_stored_proxy_password: bool,
}

fn default_port() -> u16 {
    22
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// SSH 机器配置文件包装
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SshMachineConfig {
    pub machines: Vec<SshMachine>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧版（无 proxy / jumpHost）JSON 必须能原样解析，保证升级不丢配置。
    #[test]
    fn deserializes_legacy_machine_without_route_fields() {
        let legacy = r#"{
            "id": "m1",
            "name": "legacy",
            "host": "example.com",
            "port": 22,
            "authMethod": "key",
            "identityFile": "~/.ssh/id_ed25519",
            "tags": ["prod"],
            "hasStoredPassword": true,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }"#;

        let machine: SshMachine = serde_json::from_str(legacy).expect("legacy json parses");

        assert!(machine.proxy.is_none());
        assert!(machine.jump_host.is_none());
        assert!(!machine.has_stored_proxy_password);
        assert!(machine.has_stored_password);
        assert!(!machine.uses_routed_connection());
    }

    /// 直连机器序列化后不应出现 proxy / jumpHost 字段（保持文件干净）。
    #[test]
    fn direct_connection_machine_omits_route_fields() {
        let legacy = r#"{
            "id": "m1",
            "name": "direct",
            "host": "example.com",
            "authMethod": "key",
            "tags": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }"#;
        let machine: SshMachine = serde_json::from_str(legacy).expect("legacy json parses");
        let serialized = serde_json::to_string(&machine).expect("serializes");

        assert!(!serialized.contains("proxy"));
        assert!(!serialized.contains("jumpHost"));
        assert_eq!(machine.port, 22, "port defaults to 22 when absent");
    }

    #[test]
    fn parses_proxy_and_jump_host_roundtrip() {
        let json = r#"{
            "id": "m2",
            "name": "routed",
            "host": "10.0.0.5",
            "authMethod": "key",
            "tags": [],
            "proxy": { "kind": "socks5", "host": "127.0.0.1", "port": 1080, "username": "u" },
            "jumpHost": { "machineId": "jump-1" },
            "hasStoredProxyPassword": true,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }"#;

        let machine: SshMachine = serde_json::from_str(json).expect("parses");
        let proxy = machine.proxy.clone().expect("proxy present");
        assert_eq!(proxy.kind, SshProxyKind::Socks5);
        assert_eq!(proxy.kind.as_str(), "socks5");
        assert!(proxy.requires_credentials());
        assert!(machine.uses_routed_connection());
        assert!(machine.has_stored_proxy_password);

        let jump = machine.jump_host.clone().expect("jump present");
        assert!(jump.uses_machine_reference());
        assert_eq!(jump.machine_id.as_deref(), Some("jump-1"));
        assert_eq!(jump.port, 22, "jump port defaults to 22");

        let reserialized = serde_json::to_string(&machine).expect("serializes");
        let reparsed: SshMachine = serde_json::from_str(&reserialized).expect("reparses");
        assert_eq!(reparsed.proxy, machine.proxy);
        assert_eq!(reparsed.jump_host, machine.jump_host);
    }

    #[test]
    fn inline_jump_host_without_username_needs_no_proxy_credentials() {
        let json = r#"{
            "id": "m3",
            "name": "http-proxy",
            "host": "example.org",
            "authMethod": "agent",
            "tags": [],
            "proxy": { "kind": "http", "host": "proxy.corp", "port": 3128 },
            "jumpHost": { "host": "bastion", "port": 2222, "user": "ops" },
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }"#;

        let machine: SshMachine = serde_json::from_str(json).expect("parses");
        let proxy = machine.proxy.clone().expect("proxy present");
        assert_eq!(proxy.kind, SshProxyKind::Http);
        assert!(
            !proxy.requires_credentials(),
            "proxy without username must not demand a keyring password"
        );

        let jump = machine.jump_host.expect("jump present");
        assert!(!jump.uses_machine_reference());
        assert_eq!(jump.host.as_deref(), Some("bastion"));
        assert_eq!(jump.port, 2222);
    }

    #[test]
    fn upsert_request_defaults_new_proxy_fields_to_off() {
        let legacy_request = r#"{
            "machine": {
                "id": "m1",
                "name": "n",
                "host": "h",
                "authMethod": "key",
                "tags": [],
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            },
            "rememberPassword": false,
            "clearStoredPassword": false
        }"#;

        let request: SshMachineUpsertRequest =
            serde_json::from_str(legacy_request).expect("legacy request parses");

        assert!(!request.remember_proxy_password);
        assert!(!request.clear_stored_proxy_password);
        assert!(request.proxy_password_input.is_none());
    }
}
