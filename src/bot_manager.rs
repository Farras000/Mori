use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use crate::bot::{Socks5Config};
use crate::bot_state::{BotCommand, BotState, BotStatus, CmdSender};
use crate::bot_store::{BotConfig, BotKind, BotStore, ProxyConfig};
use crate::events::{WsEvent, WsTx};
use crate::items::ItemsDat;

pub struct BotEntry {
    pub username:         String,
    pub stop_flag:        Arc<AtomicBool>,
    pub state:            Arc<RwLock<BotState>>,
    pub cmd_tx:           CmdSender,
}

pub struct BotManager {
    next_id:   u32,
    pub bots:  HashMap<u32, BotEntry>,
    pub items_dat: Arc<ItemsDat>,
    pub ws_tx: WsTx,
    /// Persistent configuration of every bot that was ever spawned.
    pub store: Arc<BotStore>,
}

#[derive(serde::Serialize)]
pub struct BotInfo {
    pub id:       u32,
    pub username: String,
    pub status:  String,
    pub world:   String,
    pub pos_x:   f32,
    pub pos_y:   f32,
    pub gems:    i32,
    pub ping_ms: u32,
    pub active_dialog: Option<crate::events::WsDialog>,
}

/// Live proxy -> storable proxy.
fn proxy_config(cfg: &Socks5Config) -> ProxyConfig {
    ProxyConfig {
        host: cfg.proxy_addr.ip().to_string(),
        port: cfg.proxy_addr.port(),
        username: cfg.username.clone(),
        password: cfg.password.clone(),
    }
}

/// Storable proxy -> live proxy.
fn proxy_from_config(cfg: &ProxyConfig) -> Option<Socks5Config> {
    let addr = format!("{}:{}", cfg.host, cfg.port).parse().ok()?;
    Some(Socks5Config {
        proxy_addr: addr,
        username: cfg.username.clone(),
        password: cfg.password.clone(),
    })
}

impl BotManager {
    pub fn new(ws_tx: WsTx) -> Self {
        Self {
            next_id: 0,
            bots: HashMap::new(),
            items_dat: Arc::new(ItemsDat::load()),
            ws_tx,
            store: Arc::new(BotStore::load()),
        }
    }

    /// Spawn a bot and remember its configuration.
    pub fn spawn(&mut self, username: String, password: String, proxy: Option<Socks5Config>, mac: Option<String>) -> u32 {
        let id = self.next_id;
        self.next_id += 1;

        // Snapshot for the store (the values move into the bot thread).
        let store_username = username.clone();
        let store_password = password.clone();
        let store_proxy = proxy.as_ref().map(proxy_config);
        let store_mac = mac.clone();

        let stop_flag   = Arc::new(AtomicBool::new(false));
        let stop_clone  = stop_flag.clone();
        let uname       = username.clone();
        let pass        = password.clone();

        let state = Arc::new(RwLock::new(BotState {
            status: BotStatus::Connecting,
            ..Default::default()
        }));
        let state_clone = state.clone();

        let (cmd_tx, cmd_rx) = mpsc::channel::<BotCommand>();

        let items_dat = self.items_dat.clone();
        let ws_tx_clone = self.ws_tx.clone();

        std::thread::spawn(move || {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut bot = crate::bot::Bot::new(&uname, &pass, proxy, state_clone, cmd_rx, items_dat, id, Some(ws_tx_clone), mac.as_deref());
                bot.run(stop_clone);
            })) {
                Ok(_)  => println!("[Bot:{id}] Stopped."),
                Err(_) => println!("[Bot:{id}] Crashed."),
            }
        });

        self.bots.insert(id, BotEntry { username: username.clone(), stop_flag, state, cmd_tx });
        let _ = self.ws_tx.send(WsEvent::BotAdded { bot_id: id, username });

        // Remember it, so a restart does not cost a full re-login.
        let mut cfg = BotConfig::new(
            id,
            BotKind::Legacy {
                username: store_username,
                password: store_password,
            },
        );
        cfg.mac = store_mac;
        cfg.proxy = store_proxy;
        self.store.upsert(cfg);
        id
    }

    /// Spawn a bot from a stored record (same id, same settings).
    pub fn spawn_saved(&mut self, cfg: &BotConfig) -> u32 {
        let id = cfg.id;
        if id >= self.next_id {
            self.next_id = id + 1;
        }
        let proxy = cfg.proxy.as_ref().and_then(proxy_from_config);
        let mac = cfg.mac.clone();
        let (kind, username, password, ltoken) = match &cfg.kind {
            BotKind::Legacy { username, password } => {
                (true, username.clone(), password.clone(), String::new())
            }
            BotKind::Ltoken { ltoken, .. } => {
                (false, String::new(), String::new(), ltoken.clone())
            }
        };
        let list_name = username.clone();

        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_clone = stop_flag.clone();
        // The saved settings are applied to the state right away, so they are
        // visible (and in effect) even before the bot finishes connecting.
        let mut initial = BotState {
            status: BotStatus::Connecting,
            ..Default::default()
        };
        initial.delays = cfg.delays.clone();
        initial.auto_collect = cfg.auto_collect;
        initial.collect_radius_tiles = cfg.collect_radius_tiles;
        initial.collect_blacklist = cfg.collect_blacklist.clone();
        initial.ignore_gems = cfg.ignore_gems;
        initial.ignore_essences = cfg.ignore_essences;
        initial.auto_leave_on_mod = cfg.auto_leave_on_mod;
        initial.auto_ban = cfg.auto_ban;
        initial.collect_path_check = cfg.collect_path_check;
        initial.auto_reconnect = cfg.auto_reconnect;
        initial.auto_rotate_reconnect = cfg.auto_rotate_reconnect;
        if let Some(p) = cfg.proxy.as_ref() {
            initial.proxy = Some(crate::bot_state::ProxyInfo {
                host: p.host.clone(),
                port: p.port,
                username: p.username.clone(),
                password: p.password.clone(),
            });
        }
        if let Some(m) = cfg.mac.as_ref() {
            initial.mac = m.clone();
        }
        let state = Arc::new(RwLock::new(initial));
        let state_clone = state.clone();
        let (cmd_tx, cmd_rx) = mpsc::channel::<BotCommand>();
        let items_dat = self.items_dat.clone();
        let ws_tx_clone = self.ws_tx.clone();
        let mac_for_thread = mac.clone();

        std::thread::spawn(move || {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if kind {
                    let mut bot = crate::bot::Bot::new(&username, &password, proxy, state_clone, cmd_rx, items_dat, id, Some(ws_tx_clone), mac_for_thread.as_deref());
                    bot.run(stop_clone);
                } else {
                    let mut bot = crate::bot::Bot::new_ltoken(&ltoken, proxy, state_clone, cmd_rx, items_dat, id, Some(ws_tx_clone));
                    bot.run(stop_clone);
                }
            })) {
                Ok(_)  => println!("[Bot:{id}] Stopped."),
                Err(_) => println!("[Bot:{id}] Crashed."),
            }
        });

        self.bots.insert(id, BotEntry { username: list_name.clone(), stop_flag, state, cmd_tx });
        let _ = self.ws_tx.send(WsEvent::BotAdded { bot_id: id, username: list_name });

        // Re-apply the saved settings (delays, collect config, proxy…).
        self.apply_config(id, cfg);
        id
    }

    /// Push the stored configuration into a running bot.
    fn apply_config(&self, id: u32, cfg: &BotConfig) {
        let Some(entry) = self.bots.get(&id) else { return };
        let _ = entry.cmd_tx.send(BotCommand::SetDelays(cfg.delays.clone()));
        let _ = entry.cmd_tx.send(BotCommand::SetAutoCollect { enabled: cfg.auto_collect });
        let _ = entry.cmd_tx.send(BotCommand::SetCollectConfig {
            radius_tiles: cfg.collect_radius_tiles,
            blacklist: cfg.collect_blacklist.clone(),
        });
        let _ = entry.cmd_tx.send(BotCommand::SetIgnoreGems { enabled: cfg.ignore_gems });
        let _ = entry.cmd_tx.send(BotCommand::SetIgnoreEssences { enabled: cfg.ignore_essences });
        let _ = entry.cmd_tx.send(BotCommand::SetAutoLeaveOnMod { enabled: cfg.auto_leave_on_mod });
        let _ = entry.cmd_tx.send(BotCommand::SetAutoBan { enabled: cfg.auto_ban });
        let _ = entry.cmd_tx.send(BotCommand::SetCollectPathCheck { enabled: cfg.collect_path_check });
        let _ = entry.cmd_tx.send(BotCommand::SetAutoReconnect { enabled: cfg.auto_reconnect });
        let _ = entry.cmd_tx.send(BotCommand::SetAutoRotateReconnect { enabled: cfg.auto_rotate_reconnect });
        if let Some(p) = cfg.proxy.as_ref().and_then(proxy_from_config) {
            let _ = entry.cmd_tx.send(BotCommand::SetProxy { proxy: Some(p) });
        }
    }

    /// Spawn every stored bot that is flagged for auto-start.
    pub fn restore_saved(&mut self) {
        let configs = self.store.list();
        if configs.is_empty() {
            return;
        }
        for cfg in &configs {
            if !cfg.auto_spawn {
                continue;
            }
            if self.bots.contains_key(&cfg.id) {
                continue;
            }
            println!("[Bot] restoring saved bot {} ({})", cfg.id, cfg.kind.label());
            self.spawn_saved(cfg);
        }
    }

    /// Copy the live configuration of every running bot into the store.
    ///
    /// Called from the bot list endpoint, so changes made through the UI,
    /// gRPC or Lua all end up on disk.
    pub fn sync_configs(&self) {
        for (id, entry) in &self.bots {
            let Some(cfg) = self.store.get(*id) else { continue };
            let st = entry.state.read().unwrap();
            let proxy_changed = match (&cfg.proxy, &st.proxy) {
                (Some(cp), Some(sp)) => {
                    cp.host != sp.host
                        || cp.port != sp.port
                        || cp.username != sp.username
                        || cp.password != sp.password
                }
                (None, None) => false,
                _ => true,
            };
            let changed = proxy_changed
                || cfg.delays != st.delays
                || cfg.auto_collect != st.auto_collect
                || cfg.collect_radius_tiles != st.collect_radius_tiles
                || cfg.collect_blacklist != st.collect_blacklist
                || cfg.ignore_gems != st.ignore_gems
                || cfg.ignore_essences != st.ignore_essences
                || cfg.auto_leave_on_mod != st.auto_leave_on_mod
                || cfg.auto_ban != st.auto_ban
                || cfg.collect_path_check != st.collect_path_check
                || cfg.auto_reconnect != st.auto_reconnect
                || cfg.auto_rotate_reconnect != st.auto_rotate_reconnect
                || cfg.mac.as_deref() != Some(st.mac.as_str());
            if !changed {
                continue;
            }
            drop(st);
            self.store.update(*id, |c| {
                c.delays = entry.state.read().unwrap().delays.clone();
                c.auto_collect = entry.state.read().unwrap().auto_collect;
                c.collect_radius_tiles = entry.state.read().unwrap().collect_radius_tiles;
                c.collect_blacklist = entry.state.read().unwrap().collect_blacklist.clone();
                c.ignore_gems = entry.state.read().unwrap().ignore_gems;
                c.ignore_essences = entry.state.read().unwrap().ignore_essences;
                c.auto_leave_on_mod = entry.state.read().unwrap().auto_leave_on_mod;
                c.auto_ban = entry.state.read().unwrap().auto_ban;
                c.collect_path_check = entry.state.read().unwrap().collect_path_check;
                c.auto_reconnect = entry.state.read().unwrap().auto_reconnect;
                c.auto_rotate_reconnect = entry.state.read().unwrap().auto_rotate_reconnect;
                c.proxy = entry.state.read().unwrap().proxy.as_ref().map(|p| ProxyConfig {
                    host: p.host.clone(),
                    port: p.port,
                    username: p.username.clone(),
                    password: p.password.clone(),
                });
                if !c.mac.as_deref().unwrap_or("").is_empty() {
                    c.mac = Some(entry.state.read().unwrap().mac.clone());
                }
            });
        }
    }

    pub fn spawn_ltoken(&mut self, ltoken_str: String, proxy: Option<Socks5Config>) -> u32 {
        let id = self.next_id;
        self.next_id += 1;

        // Snapshot for the store (the values move into the bot thread).
        let store_ltoken = ltoken_str.clone();
        let store_proxy = proxy.as_ref().map(proxy_config);

        let stop_flag  = Arc::new(AtomicBool::new(false));
        let stop_clone = stop_flag.clone();

        let state = Arc::new(RwLock::new(BotState {
            status: BotStatus::Connecting,
            ..Default::default()
        }));
        let state_clone = state.clone();

        let (cmd_tx, cmd_rx) = mpsc::channel::<BotCommand>();

        let items_dat = self.items_dat.clone();
        let ws_tx_clone = self.ws_tx.clone();

        std::thread::spawn(move || {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut bot = crate::bot::Bot::new_ltoken(&ltoken_str, proxy, state_clone, cmd_rx, items_dat, id, Some(ws_tx_clone));
                bot.run(stop_clone);
            })) {
                Ok(_)  => println!("[Bot:{id}] Stopped."),
                Err(_) => println!("[Bot:{id}] Crashed."),
            }
        });

        self.bots.insert(id, BotEntry { username: String::new(), stop_flag, state, cmd_tx });
        let _ = self.ws_tx.send(WsEvent::BotAdded { bot_id: id, username: String::new() });

        let mut cfg = BotConfig::new(
            id,
            BotKind::Ltoken {
                ltoken: store_ltoken,
                label: String::new(),
            },
        );
        cfg.proxy = store_proxy;
        self.store.upsert(cfg);
        id
    }

    /// Record a configuration command in the store.
    ///
    /// The live bot only applies the command when it is connected, so the
    /// store is updated right away - a delay changed while the bot is
    /// offline is still remembered for the next start.
    pub fn record_config_cmd(&self, id: u32, cmd: &BotCommand) {
        let Some(cfg) = self.store.get(id) else { return };
        let mut next = cfg.clone();
        let changed = match cmd {
            BotCommand::SetDelays(d) => {
                next.delays = d.clone();
                true
            }
            BotCommand::SetPlaceDelay { ms } => {
                next.delays.place_ms = *ms;
                true
            }
            BotCommand::SetWalkDelay { ms } => {
                next.delays.walk_ms = *ms;
                true
            }
            BotCommand::SetAutoCollect { enabled } => {
                next.auto_collect = *enabled;
                true
            }
            BotCommand::SetCollectConfig {
                radius_tiles,
                blacklist,
            } => {
                next.collect_radius_tiles = *radius_tiles;
                next.collect_blacklist = blacklist.clone();
                true
            }
            BotCommand::SetIgnoreGems { enabled } => {
                next.ignore_gems = *enabled;
                true
            }
            BotCommand::SetIgnoreEssences { enabled } => {
                next.ignore_essences = *enabled;
                true
            }
            BotCommand::SetAutoLeaveOnMod { enabled } => {
                next.auto_leave_on_mod = *enabled;
                true
            }
            BotCommand::SetAutoBan { enabled } => {
                next.auto_ban = *enabled;
                true
            }
            BotCommand::SetCollectPathCheck { enabled } => {
                next.collect_path_check = *enabled;
                true
            }
            BotCommand::SetAutoReconnect { enabled } => {
                next.auto_reconnect = *enabled;
                true
            }
            BotCommand::SetAutoRotateReconnect { enabled } => {
                next.auto_rotate_reconnect = *enabled;
                true
            }
            BotCommand::SetProxy { proxy } => {
                next.proxy = proxy.as_ref().map(proxy_config);
                true
            }
            _ => false,
        };
        if changed {
            self.store.upsert(next);
        }
    }

    pub fn stop(&mut self, id: u32, reason: &str) -> bool {
        if let Some(entry) = self.bots.remove(&id) {
            entry.stop_flag.store(true, Ordering::Relaxed);
            let _ = self.ws_tx.send(WsEvent::BotRemoved { bot_id: id });
            // The stored configuration is KEPT: stopping a bot is a temporary
            // action, "forgetting" it is explicit (DELETE /bots/saved/{id}).
            // Otherwise a mis-click on the stop button would cost a full
            // re-login after the next restart.
            println!("[Bot:{id}] stopped by: {reason}");
            true
        } else {
            false
        }
    }

    pub fn list(&self) -> Vec<BotInfo> {
        self.bots.iter().map(|(id, e)| {
            let s = e.state.read().unwrap();
            BotInfo {
                id:       *id,
                username: e.username.clone(),
                status:  s.status.to_string(),
                world:   s.world_name.clone(),
                pos_x:   s.pos_x,
                pos_y:   s.pos_y,
                gems:    s.gems,
                ping_ms: s.ping_ms,
                active_dialog: s.active_dialog.clone(),
            }
        }).collect()
    }

    pub fn get_state(&self, id: u32) -> Option<BotState> {
        self.bots.get(&id).map(|e| e.state.read().unwrap().clone())
    }

    pub fn send_cmd(&self, id: u32, cmd: BotCommand) -> bool {
        self.bots.get(&id).map(|e| e.cmd_tx.send(cmd).is_ok()).unwrap_or(false)
    }

    pub fn run_script(&self, id: u32, content: String) -> bool {
        self.send_cmd(id, BotCommand::RunScript { content })
    }

    pub fn find_by_name(&self, name: &str) -> Option<(Arc<RwLock<BotState>>, CmdSender)> {
        self.bots.values()
            .find(|e| e.username.eq_ignore_ascii_case(name))
            .map(|e| (e.state.clone(), e.cmd_tx.clone()))
    }

    pub fn stop_by_name(&mut self, name: &str) -> bool {
        if let Some(id) = self.bots.iter()
            .find(|(_, e)| e.username.eq_ignore_ascii_case(name))
            .map(|(id, _)| *id)
        {
            self.stop(id, "stop_by_name")
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bot_state::BotState;
    use std::path::PathBuf;

    fn manager_for_test() -> (BotManager, PathBuf) {
        let path = std::env::temp_dir().join(format!("mori-bots-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        let mgr = BotManager {
            next_id: 0,
            bots: HashMap::new(),
            items_dat: Arc::new(ItemsDat::load()),
            ws_tx: tx,
            store: Arc::new(BotStore::load_from(path.clone())),
        };
        (mgr, path)
    }

    fn fake_bot(id: u32, name: &str) -> BotEntry {
        BotEntry {
            username: name.to_string(),
            stop_flag: Arc::new(AtomicBool::new(false)),
            state: Arc::new(RwLock::new(BotState::default())),
            cmd_tx: mpsc::channel().0,
        }
    }

    #[test]
    fn stopping_a_bot_keeps_its_saved_record() {
        let (mut mgr, path) = manager_for_test();
        mgr.store.upsert(BotConfig::new(
            7,
            BotKind::Legacy {
                username: "growid_user".into(),
                password: "secret".into(),
            },
        ));
        mgr.bots.insert(7, fake_bot(7, "growid_user"));

        assert!(mgr.stop(7, "test"));
        // The credentials stay: a stop is temporary, forgetting is explicit.
        assert!(
            mgr.store.get(7).is_some(),
            "stopping must not forget the saved bot"
        );
        assert!(mgr.bots.get(&7).is_none());

        // Explicit forget removes it.
        mgr.store.remove(7);
        assert!(mgr.store.get(7).is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stopping_an_unknown_bot_is_a_no_op() {
        let (mut mgr, path) = manager_for_test();
        assert!(!mgr.stop(99, "test"));
        let _ = std::fs::remove_file(path);
    }
}
