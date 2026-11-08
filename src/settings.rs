//! Persistent app settings (`data/settings.json`) — currently the general proxy.
//!
//! The general proxy is the app-wide default for every Growtopia-bound
//! connection that has no explicit proxy configured: Google login, legacy
//! login, ltoken spawn, saved bots and bot restore. An explicit per-form /
//! per-bot proxy always wins; a disabled or empty general proxy = direct.
//!
//! The file lives inside `data/` (git-ignored) and is written atomically
//! (temp file + rename) with `0600` permissions on unix. Like `data/bots.json`
//! it contains **live credentials in plain text** — treat it like a password.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::bot::Socks5Config;

/// Where the settings live on disk.
pub const STORE_PATH: &str = "data/settings.json";

/// The app-wide proxy. `enabled && host non-empty && port > 0` = active.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GeneralProxy {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

impl GeneralProxy {
    pub fn is_set(&self) -> bool {
        self.enabled && !self.host.trim().is_empty() && self.port != 0
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub general_proxy: GeneralProxy,
}

impl AppSettings {
    /// The general proxy as a live `Socks5Config`, when enabled and resolvable.
    pub fn general_proxy_config(&self) -> Option<Socks5Config> {
        let gp = &self.general_proxy;
        if !gp.is_set() {
            return None;
        }
        let host = gp.host.trim();
        let addr: std::net::SocketAddr = format!("{host}:{}", gp.port)
            .parse()
            .ok()
            .or_else(|| {
                use std::net::ToSocketAddrs;
                format!("{host}:{}", gp.port).to_socket_addrs().ok()?.next()
            })?;
        Some(Socks5Config {
            proxy_addr: addr,
            username: gp.username.clone(),
            password: gp.password.clone(),
        })
    }

    pub fn load() -> Self {
        let path = PathBuf::from(STORE_PATH);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        serde_json::from_str(&raw).unwrap_or_else(|e| {
            eprintln!("[Mori] Failed to parse {STORE_PATH} ({e}); using defaults");
            Self::default()
        })
    }

    pub fn save(&self) -> std::io::Result<()> {
        let path = PathBuf::from(STORE_PATH);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, raw)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &path)
    }
}
