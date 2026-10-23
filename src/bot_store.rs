//! Persistent bot configuration (`data/bots.json`).
//!
//! The server keeps bots in memory only, so a restart lost every login, proxy
//! and delay. This store keeps the *configuration* of every bot that was
//! spawned, so a restart only costs one click ("Spawn" in the UI) instead of
//! retyping the credentials.
//!
//! The file lives inside `data/` (git-ignored) and is written atomically
//! (temp file + rename) with `0600` permissions on unix. It contains **live
//! credentials in plain text** — treat it like a password file.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::bot_state::BotDelays;

/// Where the bots live on disk.
pub const STORE_PATH: &str = "data/bots.json";

fn default_true() -> bool {
    true
}
fn default_radius() -> u8 {
    3
}

/// How the bot authenticates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BotKind {
    /// Classic GrowID login (username + password).
    Legacy { username: String, password: String },
    /// Session bundle `token|rid|mac|wk` (Google login or a pasted ltoken).
    Ltoken { ltoken: String, label: String },
}

impl BotKind {
    /// Short name shown in the UI (never the secret).
    pub fn label(&self) -> String {
        match self {
            BotKind::Legacy { username, .. } => username.clone(),
            BotKind::Ltoken { label, .. } => {
                if label.is_empty() {
                    "ltoken".to_string()
                } else {
                    label.clone()
                }
            }
        }
    }
}

/// Proxy settings (plain text, same as the live bot state).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxyConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Everything needed to bring a bot back after a restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotConfig {
    /// Stable bot id (kept across restarts so scripts/Lua keep working).
    pub id: u32,
    pub kind: BotKind,
    #[serde(default)]
    pub mac: Option<String>,
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
    #[serde(default)]
    pub delays: BotDelays,
    #[serde(default = "default_true")]
    pub auto_collect: bool,
    #[serde(default = "default_radius")]
    pub collect_radius_tiles: u8,
    #[serde(default)]
    pub collect_blacklist: Vec<u16>,
    #[serde(default)]
    pub ignore_gems: bool,
    #[serde(default)]
    pub ignore_essences: bool,
    #[serde(default)]
    pub auto_leave_on_mod: bool,
    #[serde(default)]
    pub auto_ban: bool,
    #[serde(default = "default_true")]
    pub collect_path_check: bool,
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
    /// Spawn this bot automatically when the server starts.
    #[serde(default)]
    pub auto_spawn: bool,
    #[serde(default)]
    pub saved_at: u64,
}

impl BotConfig {
    pub fn new(id: u32, kind: BotKind) -> Self {
        Self {
            id,
            kind,
            mac: None,
            proxy: None,
            delays: BotDelays::default(),
            auto_collect: true,
            collect_radius_tiles: 3,
            collect_blacklist: Vec::new(),
            ignore_gems: false,
            ignore_essences: false,
            auto_leave_on_mod: false,
            auto_ban: false,
            collect_path_check: true,
            auto_reconnect: true,
            auto_spawn: false,
            saved_at: now_secs(),
        }
    }

    /// Public view of a record (no secrets).
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "label": self.kind.label(),
            "kind": match self.kind {
                BotKind::Legacy { .. } => "legacy",
                BotKind::Ltoken { .. } => "ltoken",
            },
            "mac": self.mac,
            "proxy": self.proxy.as_ref().map(|p| serde_json::json!({
                "host": p.host, "port": p.port, "username": p.username,
            })),
            "delays": self.delays,
            "auto_collect": self.auto_collect,
            "collect_radius_tiles": self.collect_radius_tiles,
            "ignore_gems": self.ignore_gems,
            "ignore_essences": self.ignore_essences,
            "auto_leave_on_mod": self.auto_leave_on_mod,
            "auto_ban": self.auto_ban,
            "collect_path_check": self.collect_path_check,
            "auto_reconnect": self.auto_reconnect,
            "auto_spawn": self.auto_spawn,
            "saved_at": self.saved_at,
        })
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The on-disk store: `data/bots.json`.
pub struct BotStore {
    path: PathBuf,
    inner: Mutex<BTreeMap<u32, BotConfig>>,
}

impl BotStore {
    /// Load the store (a missing or corrupt file yields an empty store).
    pub fn load() -> Self {
        Self::load_from(STORE_PATH)
    }

    /// Load a store from an explicit path (tests, alternative locations).
    pub fn load_from(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let mut map = BTreeMap::new();
        if let Ok(raw) = std::fs::read_to_string(&path) {
            match serde_json::from_str::<BTreeMap<u32, BotConfig>>(&raw) {
                Ok(m) => map = m,
                Err(e) => println!("[store] {} is unreadable ({e}) - starting empty", path.display()),
            }
        }
        Self {
            path,
            inner: Mutex::new(map),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<u32, BotConfig>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// All records (id order).
    pub fn list(&self) -> Vec<BotConfig> {
        self.lock().values().cloned().collect()
    }

    pub fn get(&self, id: u32) -> Option<BotConfig> {
        self.lock().get(&id).cloned()
    }

    /// Insert or replace a record and persist.
    pub fn upsert(&self, cfg: BotConfig) {
        {
            let mut map = self.lock();
            map.insert(cfg.id, cfg);
        }
        self.persist();
    }

    /// Mutate a record in place and persist.
    pub fn update<F: FnOnce(&mut BotConfig)>(&self, id: u32, f: F) {
        {
            let mut map = self.lock();
            if let Some(cfg) = map.get_mut(&id) {
                f(cfg);
            }
        }
        self.persist();
    }

    /// Drop a record and persist.
    pub fn remove(&self, id: u32) {
        {
            let mut map = self.lock();
            map.remove(&id);
        }
        self.persist();
    }

    /// Write the file (atomic: temp file + rename).
    pub fn persist(&self) {
        let json = {
            let map = self.lock();
            serde_json::to_string_pretty(&*map).unwrap_or_else(|_| "{}".to_string())
        };
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, json.as_bytes()).is_err() {
            println!("[store] cannot write {}", tmp.display());
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        if let Err(e) = std::fs::rename(&tmp, &self.path) {
            println!("[store] cannot replace {}: {e}", self.path.display());
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store(name: &str) -> (BotStore, PathBuf) {
        let path = std::env::temp_dir().join(format!("mori-store-{name}.json"));
        let _ = std::fs::remove_file(&path);
        let store = BotStore {
            path: path.clone(),
            inner: Mutex::new(BTreeMap::new()),
        };
        (store, path)
    }

    fn legacy(id: u32) -> BotConfig {
        BotConfig::new(
            id,
            BotKind::Legacy {
                username: "growid_user".into(),
                password: "secret".into(),
            },
        )
    }

    #[test]
    fn upsert_and_get() {
        let (store, path) = tmp_store("upsert");
        store.upsert(legacy(1));
        let got = store.get(1).expect("record");
        assert_eq!(got.kind.label(), "growid_user");
        // The public view must not leak the password.
        let view = got.public().to_string();
        assert!(!view.contains("secret"), "{view}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn remove_drops_the_record() {
        let (store, path) = tmp_store("remove");
        store.upsert(legacy(3));
        store.remove(3);
        assert!(store.get(3).is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn auto_spawn_defaults_to_off() {
        let cfg = legacy(1);
        assert!(!cfg.auto_spawn, "auto-start must be opt-in");
    }

    #[test]
    fn file_roundtrips_through_json() {
        let mut cfg = legacy(2);
        cfg.delays.place_ms = 180;
        cfg.delays.walk_ms = 200;
        cfg.proxy = Some(ProxyConfig {
            host: "1.2.3.4".into(),
            port: 1080,
            username: Some("u".into()),
            password: Some("p".into()),
        });
        let json = serde_json::to_string(&cfg).unwrap();
        let back: BotConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.delays.place_ms, 180);
        assert_eq!(back.delays.walk_ms, 200);
        assert_eq!(back.proxy.as_ref().unwrap().port, 1080);
        assert_eq!(back.kind.label(), "growid_user");
    }
}
