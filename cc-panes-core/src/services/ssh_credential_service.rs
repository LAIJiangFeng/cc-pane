use crate::utils::APP_DIR_NAME;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

trait CredentialBackend: Send + Sync {
    fn set_password(&self, machine_id: &str, password: &str) -> Result<()>;
    fn get_password(&self, machine_id: &str) -> Result<Option<String>>;
    fn delete_password(&self, machine_id: &str) -> Result<()>;
}

struct SystemCredentialBackend {
    service_name: String,
}

impl SystemCredentialBackend {
    fn new() -> Self {
        Self {
            service_name: format!("cc-panes:{}:ssh-machine", APP_DIR_NAME),
        }
    }

    fn entry(&self, machine_id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service_name, machine_id)
            .with_context(|| format!("Failed to open system credential entry for {}", machine_id))
    }
}

impl CredentialBackend for SystemCredentialBackend {
    fn set_password(&self, machine_id: &str, password: &str) -> Result<()> {
        self.entry(machine_id)?
            .set_password(password)
            .with_context(|| format!("Failed to store password for {}", machine_id))?;
        Ok(())
    }

    fn get_password(&self, machine_id: &str) -> Result<Option<String>> {
        match self.entry(machine_id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error)
                .with_context(|| format!("Failed to read stored password for {}", machine_id)),
        }
    }

    fn delete_password(&self, machine_id: &str) -> Result<()> {
        match self.entry(machine_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error)
                .with_context(|| format!("Failed to delete stored password for {}", machine_id)),
        }
    }
}

struct MemoryCredentialBackend {
    entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl MemoryCredentialBackend {
    fn new() -> Self {
        Self {
            entries: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

impl CredentialBackend for MemoryCredentialBackend {
    fn set_password(&self, machine_id: &str, password: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(machine_id.to_string(), password.to_string());
        Ok(())
    }

    fn get_password(&self, machine_id: &str) -> Result<Option<String>> {
        Ok(self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(machine_id)
            .cloned())
    }

    fn delete_password(&self, machine_id: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(machine_id);
        Ok(())
    }
}

pub struct SshCredentialService {
    backend: Arc<dyn CredentialBackend>,
    temporary_passwords: Mutex<HashMap<String, String>>,
}

impl Default for SshCredentialService {
    fn default() -> Self {
        Self::new()
    }
}

impl SshCredentialService {
    pub fn new() -> Self {
        Self {
            backend: Arc::new(SystemCredentialBackend::new()),
            temporary_passwords: Mutex::new(HashMap::new()),
        }
    }

    pub fn new_memory() -> Self {
        Self {
            backend: Arc::new(MemoryCredentialBackend::new()),
            temporary_passwords: Mutex::new(HashMap::new()),
        }
    }

    pub fn store_password(&self, machine_id: &str, password: &str) -> Result<()> {
        self.backend.set_password(machine_id, password)?;
        self.clear_temporary_password(machine_id);
        Ok(())
    }

    pub fn store_temporary_password(&self, machine_id: &str, password: &str) {
        self.temporary_passwords
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(machine_id.to_string(), password.to_string());
    }

    pub fn load_password(&self, machine_id: &str) -> Result<Option<String>> {
        self.backend.get_password(machine_id)
    }

    pub fn load_connection_password(&self, machine_id: &str) -> Result<Option<String>> {
        if let Some(password) = self
            .temporary_passwords
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(machine_id)
            .cloned()
        {
            return Ok(Some(password));
        }
        self.load_password(machine_id)
    }

    pub fn has_password(&self, machine_id: &str) -> Result<bool> {
        Ok(self.load_password(machine_id)?.is_some())
    }

    pub fn delete_password(&self, machine_id: &str) -> Result<()> {
        self.backend.delete_password(machine_id)?;
        self.clear_temporary_password(machine_id);
        Ok(())
    }

    pub fn clear_temporary_password(&self, machine_id: &str) {
        self.temporary_passwords
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(machine_id);
    }

    // ---- 代理凭据 -------------------------------------------------------
    //
    // 代理密码与主机密码同样只存 keyring，绝不落盘或进模型。账号名用
    // `{machine_id}:proxy` 复合键复用同一个 keyring service：机器 id 是 UUID，
    // 不可能自带 `:proxy` 后缀，因此与主机密码条目天然不冲突。

    /// 写入持久化代理密码（系统 keyring）。
    pub fn store_proxy_password(&self, machine_id: &str, password: &str) -> Result<()> {
        self.backend
            .set_password(&proxy_account(machine_id), password)?;
        self.clear_temporary_proxy_password(machine_id);
        Ok(())
    }

    /// 写入仅存活于本次进程的代理密码，用于「不记住密码」的一次性认证。
    pub fn store_temporary_proxy_password(&self, machine_id: &str, password: &str) {
        self.temporary_passwords
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(proxy_account(machine_id), password.to_string());
    }

    /// 只读持久化代理密码。
    pub fn load_proxy_password(&self, machine_id: &str) -> Result<Option<String>> {
        self.backend.get_password(&proxy_account(machine_id))
    }

    /// 连接时使用的代理密码：优先内存临时值，回退 keyring。
    pub fn load_connection_proxy_password(&self, machine_id: &str) -> Result<Option<String>> {
        let account = proxy_account(machine_id);
        if let Some(password) = self
            .temporary_passwords
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&account)
            .cloned()
        {
            return Ok(Some(password));
        }
        self.backend.get_password(&account)
    }

    pub fn has_proxy_password(&self, machine_id: &str) -> Result<bool> {
        Ok(self.load_proxy_password(machine_id)?.is_some())
    }

    pub fn delete_proxy_password(&self, machine_id: &str) -> Result<()> {
        self.backend.delete_password(&proxy_account(machine_id))?;
        self.clear_temporary_proxy_password(machine_id);
        Ok(())
    }

    pub fn clear_temporary_proxy_password(&self, machine_id: &str) {
        self.temporary_passwords
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&proxy_account(machine_id));
    }
}

/// 代理密码在 keyring / 临时缓存中使用的账号名。
fn proxy_account(machine_id: &str) -> String {
    format!("{machine_id}:proxy")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_password_is_used_for_connections_without_becoming_persistent() {
        let service = SshCredentialService::new_memory();
        service.store_temporary_password("m1", "temporary");

        assert_eq!(service.load_password("m1").unwrap(), None);
        assert_eq!(
            service.load_connection_password("m1").unwrap().as_deref(),
            Some("temporary")
        );

        service.store_password("m1", "persisted").unwrap();
        assert_eq!(
            service.load_connection_password("m1").unwrap().as_deref(),
            Some("persisted")
        );
    }

    /// 代理密码与主机密码必须互相隔离：同一台机器可以有两个不同的密码，
    /// 删除其一个绝不能影响另一个。
    #[test]
    fn proxy_password_is_isolated_from_host_password() {
        let service = SshCredentialService::new_memory();
        service.store_password("m1", "host-secret").unwrap();
        service.store_proxy_password("m1", "proxy-secret").unwrap();

        assert_eq!(
            service.load_password("m1").unwrap().as_deref(),
            Some("host-secret")
        );
        assert_eq!(
            service.load_proxy_password("m1").unwrap().as_deref(),
            Some("proxy-secret")
        );
        assert!(service.has_proxy_password("m1").unwrap());

        service.delete_proxy_password("m1").unwrap();
        assert!(!service.has_proxy_password("m1").unwrap());
        assert_eq!(
            service.load_password("m1").unwrap().as_deref(),
            Some("host-secret"),
            "deleting the proxy password must not touch the host password"
        );
    }

    #[test]
    fn temporary_proxy_password_wins_without_becoming_persistent() {
        let service = SshCredentialService::new_memory();
        service.store_temporary_proxy_password("m1", "ephemeral");

        assert_eq!(service.load_proxy_password("m1").unwrap(), None);
        assert!(
            !service.has_proxy_password("m1").unwrap(),
            "temporary proxy passwords must not be reported as stored"
        );
        assert_eq!(
            service
                .load_connection_proxy_password("m1")
                .unwrap()
                .as_deref(),
            Some("ephemeral")
        );

        // 持久化后应清掉临时值，避免过期口令继续被使用。
        service.store_proxy_password("m1", "persisted").unwrap();
        assert_eq!(
            service
                .load_connection_proxy_password("m1")
                .unwrap()
                .as_deref(),
            Some("persisted")
        );

        service.clear_temporary_proxy_password("m1");
        assert_eq!(
            service
                .load_connection_proxy_password("m1")
                .unwrap()
                .as_deref(),
            Some("persisted")
        );
    }

    /// 主机密码的临时值不得泄漏成代理密码（共享同一张临时表，靠键区分）。
    #[test]
    fn host_temporary_password_does_not_leak_into_proxy_lookup() {
        let service = SshCredentialService::new_memory();
        service.store_temporary_password("m1", "host-only");

        assert_eq!(
            service.load_connection_proxy_password("m1").unwrap(),
            None,
            "a host password must never be used as a proxy password"
        );
        assert_eq!(
            service.load_connection_password("m1").unwrap().as_deref(),
            Some("host-only")
        );
    }
}
