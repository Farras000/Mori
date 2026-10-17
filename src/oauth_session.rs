//! Google OAuth session orchestration.
//!
//! One `PendingOAuth` per login attempt holds the mint agent (the single
//! cookie jar across dashboard → redirect → callback → checktoken, report
//! 07 §3) plus the descriptor parts needed to build the `token|rid|mac|wk`
//! bundle `Bot::new_ltoken` parses.
//!
//! Flows:
//! - in-modal browser (primary): `start` mints, opens a dedicated CloakBrowser
//!   tab ([`crate::remote_view`]: seeded cookies, authorize URL, screencast),
//!   and watches for the landing token in the background. The operator
//!   completes Google login + consent inside Mori's browser modal
//!   (`GET /oauth/google/:id/view` frames up/down the WS).
//! - manual fallback (no cloak configured): `start` returns the authorize URL
//!   + seed cookies for import; the operator finishes in any real browser,
//!   then `submit_callback_url` (same-jar fetch, like the game's single
//!   WebView2 store) or `submit_landing_token` (demo `--token` equivalent)
//!   completes the exchange.
//! - `refresh` replays the form checktoken as a single POST with the stored
//!   descriptor (demo `--refresh` equivalent, no browser).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::bot::Socks5Config;
use crate::google_oauth::{
    MintedSession, OAuthError, SeedCookie, ValidatedBundle, mint_with_backoff, step_callback,
    step_checktoken,
};
use crate::remote_view::{self, CloakConfig, RemoteViewer, ViewerMsg};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OAuthStatus {
    /// Minted; waiting for the operator in the browser window.
    WaitingBrowser,
    /// Background CDP watch in progress.
    Watching,
    /// Exchange running.
    Validating,
    Validated {
        token: String,
        account_type: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OAuthSessionView {
    pub id: String,
    pub created_at: u64,
    pub authorize_url: String,
    pub seed_cookies: Vec<SeedCookie>,
    pub status: OAuthStatus,
    /// Present once validated — feed `ltoken` to `POST /bots/ltoken` or the spawn endpoint.
    pub ltoken: Option<String>,
    /// A live remote-viewer tab exists (modal can attach).
    pub viewer_live: bool,
}

struct PendingOAuth {
    created_at: u64,
    agent: ureq::Agent,
    proxy_url: Option<String>,
    authorize_url: String,
    seed_cookies: Vec<SeedCookie>,
    desc_raw: String,
    rid: String,
    mac: String,
    wk: String,
    status: OAuthStatus,
    validated: Option<ValidatedBundle>,
    viewer: Option<Arc<RemoteViewer>>,
}

impl PendingOAuth {
    fn view(&self, id: &str) -> OAuthSessionView {
        OAuthSessionView {
            id: id.to_string(),
            created_at: self.created_at,
            authorize_url: self.authorize_url.clone(),
            seed_cookies: self.seed_cookies.clone(),
            status: self.status.clone(),
            ltoken: self.validated.as_ref().map(|v| v.ltoken_string()),
            viewer_live: self.viewer.as_ref().is_some_and(|v| v.is_alive()),
        }
    }
}

#[derive(Clone, Default)]
pub struct OAuthStore {
    inner: Arc<Mutex<HashMap<String, PendingOAuth>>>,
}

impl OAuthStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[allow(dead_code)]
fn _assert_store_traits() {
    fn assert_sync<T: Sync>() {}
    fn assert_send<T: Send>() {}
    assert_sync::<OAuthStore>();
    assert_send::<ureq::Agent>();
    assert_sync::<ureq::Agent>();
}

#[allow(dead_code)]
fn _assert_refresh_future_send(store: &OAuthStore) {
    fn assert_send<T: Send>(_: T) {}
    assert_send(store.refresh("x"));
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn proxy_url(cfg: Option<&Socks5Config>) -> Option<String> {
    cfg.map(|p| p.to_url())
}

impl OAuthStore {
    pub fn get(&self, id: &str) -> Option<OAuthSessionView> {
        self.inner.lock().ok()?.get(id).map(|p| p.view(id))
    }

    fn set_status(&self, id: &str, status: OAuthStatus) {
        if let Ok(mut m) = self.inner.lock()
            && let Some(p) = m.get_mut(id) {
                p.status = status;
            }
    }

    fn store_validated(&self, id: &str, bundle: ValidatedBundle) {
        let viewer = if let Ok(mut m) = self.inner.lock()
            && let Some(p) = m.get_mut(id) {
                p.status = OAuthStatus::Validated {
                    token: bundle.token.clone(),
                    account_type: bundle.account_type.clone(),
                };
                p.validated = Some(bundle.clone());
                p.viewer.take()
            } else {
                None
            };
        // Session is terminal — tear down the tab without blocking the response.
        if let Some(v) = viewer {
            tokio::spawn(async move {
                let _ = v.close().await;
            });
        }
        persist_validated(&bundle);
    }

    /// Mark failed AND tear down the tab (terminal state).
    fn fail(&self, id: &str, reason: String) {
        let viewer = if let Ok(mut m) = self.inner.lock()
            && let Some(p) = m.get_mut(id) {
                p.status = OAuthStatus::Failed { reason };
                p.viewer.take()
            } else {
                None
            };
        if let Some(v) = viewer {
            tokio::spawn(async move {
                let _ = v.close().await;
            });
        }
    }

    /// Bound the map: terminal sessions (viewer already torn down) go first,
    /// oldest wins; a live viewer on an evicted entry gets its tab closed so
    /// CloakBrowser doesn't accumulate orphans.
    fn evict_old(&self) {
        const MAX_SESSIONS: usize = 32;
        let victim = if let Ok(m) = self.inner.lock() {
            if m.len() <= MAX_SESSIONS {
                return;
            }
            m.iter()
                .filter(|(_, p)| {
                    matches!(
                        p.status,
                        OAuthStatus::Validated { .. } | OAuthStatus::Failed { .. }
                    )
                })
                .min_by_key(|(_, p)| p.created_at)
                .map(|(k, _)| k.clone())
                .or_else(|| {
                    m.iter()
                        .min_by_key(|(_, p)| p.created_at)
                        .map(|(k, _)| k.clone())
                })
        } else {
            None
        };
        if let Some(k) = victim
            && let Ok(mut m) = self.inner.lock()
                && let Some(p) = m.remove(&k) {
                    if let Some(v) = p.viewer {
                        tokio::spawn(async move {
                            let _ = v.close().await;
                        });
                    }
                }
    }

    /// Attach the remote-viewer tab to a session (called once by the browser leg).
    fn attach_viewer(&self, id: &str, viewer: Arc<RemoteViewer>) {
        if let Ok(mut m) = self.inner.lock()
            && let Some(p) = m.get_mut(id) {
                p.viewer = Some(viewer);
            }
    }

    /// Frame subscription for the modal WS (`/oauth/google/:id/view`).
    pub fn subscribe_frames(&self, id: &str) -> Option<tokio::sync::broadcast::Receiver<Vec<u8>>> {
        self.inner
            .lock()
            .ok()?
            .get(id)?
            .viewer
            .as_ref()
            .map(|v| v.subscribe_frames())
    }

    /// Forward one viewer input message to the tab. False = no live viewer.
    pub async fn submit_input(&self, id: &str, msg: ViewerMsg) -> bool {
        let viewer = self
            .inner
            .lock()
            .ok()
            .and_then(|m| m.get(id)?.viewer.clone());
        match viewer {
            Some(v) => v.handle_input(msg).await.is_ok(),
            None => false,
        }
    }

    /// Mint a fresh dashboard session (blocking HTTP — call via `spawn_blocking`),
    /// register it, and kick off the cloak CDP leg when configured.
    /// Returns the session view with `authorize_url` + `seed_cookies`.
    pub async fn start(
        &self,
        proxy: Option<Socks5Config>,
        watch_timeout_secs: u64,
        mac: Option<String>,
    ) -> Result<OAuthSessionView, String> {
        let proxy_url = proxy_url(proxy.as_ref());
        let proxy_url_for_mint = proxy_url.clone();
        let minted: MintedSession = tokio::task::spawn_blocking(move || {
            mint_with_backoff(proxy_url_for_mint.as_deref(), 3, mac.as_deref())
        })
        .await
        .map_err(|e| format!("mint task failed: {e}"))?
        .map_err(|e| match e {
            OAuthError::Retryable(m) => format!("dashboard throttled after retries: {m}"),
            OAuthError::Fatal(m) => m,
        })?;

        let id = uuid::Uuid::new_v4().to_string();
        let pending = PendingOAuth {
            created_at: now_secs(),
            agent: minted.agent,
            proxy_url: proxy_url.clone(),
            authorize_url: minted.authorize.url.clone(),
            seed_cookies: minted.seed_cookies,
            desc_raw: minted.desc.raw,
            rid: minted.desc.rid,
            mac: minted.desc.mac,
            wk: minted.desc.wk,
            status: OAuthStatus::WaitingBrowser,
            validated: None,
            viewer: None,
        };
        let view = pending.view(&id);
        self.inner.lock().map_err(|_| "store lock poisoned".to_string())?.insert(id.clone(), pending);
        self.evict_old();

        // Background CDP leg (primary path). Manual endpoints remain usable regardless.
        if CloakConfig::from_env().is_some() {
            self.set_status(&id, OAuthStatus::Watching);
            let store = self.clone();
            tokio::spawn(async move {
                run_browser_leg(store, id, watch_timeout_secs).await;
            });
        }
        self.get(&view.id).ok_or_else(|| "session vanished".to_string())
    }

    /// Manual path: fetch the operator-pasted `/google/callback?code&state`
    /// URL with the SAME jar, then validate.
    pub async fn submit_callback_url(&self, id: &str, callback_url: String) -> Result<OAuthSessionView, String> {
        let (agent, _proxy_url, authorize_url, desc) = self.checkout_for_exchange(id)?;
        self.set_status(id, OAuthStatus::Validating);
        let result = tokio::task::spawn_blocking(move || {
            let landing = step_callback(&agent, callback_url.trim(), &authorize_url)
                .map_err(|e| e.to_string())?;
            // Rebuild descriptor parts for the bundle.
            let d = desc;
            step_checktoken(&agent, &landing, &d).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("exchange task failed: {e}"))?;
        match result {
            Ok(bundle) => {
                self.store_validated(id, bundle);
                self.get(id).ok_or_else(|| "session vanished".to_string())
            }
            Err(e) => {
                self.fail(id, e.clone());
                Err(e)
            }
        }
    }

    /// Manual path: operator pastes the landing-page `token` (demo `--token`).
    /// Note: without the browser's callback cookies this can hit the 07 §3
    /// jar-split reject — prefer the callback-URL path or the cloak leg.
    pub async fn submit_landing_token(&self, id: &str, token: String) -> Result<OAuthSessionView, String> {
        let (agent, _proxy_url, _authorize_url, desc) = self.checkout_for_exchange(id)?;
        self.set_status(id, OAuthStatus::Validating);
        let result = tokio::task::spawn_blocking(move || {
            let d = desc;
            step_checktoken(&agent, token.trim(), &d).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("exchange task failed: {e}"))?;
        match result {
            Ok(bundle) => {
                self.store_validated(id, bundle);
                self.get(id).ok_or_else(|| "session vanished".to_string())
            }
            Err(e) => {
                self.fail(id, e.clone());
                Err(e)
            }
        }
    }

    /// Browserless re-login (demo `--refresh`): single form checktoken POST
    /// with the stored descriptor. Fails → token dead → do a browser run.
    pub async fn refresh(&self, id: &str) -> Result<OAuthSessionView, String> {
        // Scope the lock: the blocking guard must not be held across `.await`
        // (`MutexGuard` is `!Send`).
        let (agent, desc_raw, validated) = {
            let inner = self.inner.lock().map_err(|_| "store lock poisoned".to_string())?;
            let p = inner.get(id).ok_or_else(|| "unknown oauth session".to_string())?;
            (
                p.agent.clone(),
                p.desc_raw.clone(),
                p.validated.clone().ok_or_else(|| "session not validated yet".to_string())?,
            )
        };
        self.set_status(id, OAuthStatus::Validating);
        let result = tokio::task::spawn_blocking(move || {
            let d = crate::google_oauth::OAuthDescriptor {
                raw: desc_raw,
                rid: validated.rid.clone(),
                mac: validated.mac.clone(),
                wk: validated.wk.clone(),
                hash: crate::protocol::crypto::hash_string("RT"),
            };
            step_checktoken(&agent, &validated.token, &d).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("refresh task failed: {e}"))?;
        match result {
            Ok(bundle) => {
                self.store_validated(id, bundle);
                self.get(id).ok_or_else(|| "session vanished".to_string())
            }
            Err(e) => {
                self.fail(
                    id,
                    format!("saved token dead — re-run the browser flow: {e}"),
                );
                Err(e)
            }
        }
    }

    /// Take a snapshot needed for an exchange; rejects double-validation races.
    fn checkout_for_exchange(
        &self,
        id: &str,
    ) -> Result<(ureq::Agent, Option<String>, String, crate::google_oauth::OAuthDescriptor), String> {
        let inner = self.inner.lock().map_err(|_| "store lock poisoned".to_string())?;
        let p = inner.get(id).ok_or_else(|| "unknown oauth session".to_string())?;
        match &p.status {
            OAuthStatus::Validated { .. } => return Err("session already validated".to_string()),
            OAuthStatus::Validating => return Err("exchange already in progress".to_string()),
            _ => {}
        }
        Ok((
            p.agent.clone(),
            p.proxy_url.clone(),
            p.authorize_url.clone(),
            crate::google_oauth::OAuthDescriptor {
                raw: p.desc_raw.clone(),
                rid: p.rid.clone(),
                mac: p.mac.clone(),
                wk: p.wk.clone(),
                hash: crate::protocol::crypto::hash_string("RT"),
            },
        ))
    }

    /// Validated `token|rid|mac|wk` bundle for spawning (None until validated).
    pub fn ltoken_bundle(&self, id: &str) -> Option<String> {
        self.inner.lock().ok()?.get(id)?.validated.as_ref().map(|v| v.ltoken_string())
    }

    /// Fresh same-jar agent for out-of-band callback fetch attempts.
    /// (Kept for symmetry with the demo's `--callback` mode; the primary
    /// manual path is `submit_callback_url`.)
    pub fn agent_for(&self, id: &str) -> Option<ureq::Agent> {
        self.inner.lock().ok()?.get(id).map(|p| p.agent.clone())
    }
}

/// Background browser leg: open the dedicated viewer tab (seeded cookies +
/// authorize URL + screencast) → headless watch → checktoken.
/// Runs as a tokio task; updates store status throughout. The operator drives
/// the tab from Mori's browser modal; detection works with or without it.
async fn run_browser_leg(store: OAuthStore, id: String, watch_timeout_secs: u64) {
    let fail = |reason: String| {
        store.fail(&id, reason);
    };
    let Some(cfg) = CloakConfig::from_env() else {
        fail("CLOAKBROWSER_CDP_HTTP not set".to_string());
        return;
    };
    let view = match store.get(&id) {
        Some(v) => v,
        None => return,
    };

    let viewer = match RemoteViewer::open(&cfg, &view.seed_cookies, &view.authorize_url).await {
        Ok(v) => v,
        Err(e) => {
            fail(format!("viewer open failed: {e}"));
            return;
        }
    };
    store.attach_viewer(&id, viewer.clone());
    println!("[oauth:{id}] login tab ready — open it from the Google tab (Open browser)");

    let (log_tx, mut log_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let print_id = id.clone();
    tokio::spawn(async move {
        while let Some(msg) = log_rx.recv().await {
            println!("[oauth:{print_id}] {msg}");
        }
    });
    let token = remote_view::watch_for_token(&viewer, watch_timeout_secs, &log_tx).await;
    let Some(landing) = token else {
        fail("no success token seen before timeout — state likely spent, restart with fresh mint".to_string());
        return;
    };

    // Validate on the mint agent (single jar). The cloak tab saw the callback
    // in its own profile; if the server rejects (jar split), the operator can
    // paste the /google/callback URL via the callback endpoint, which replays
    // the callback fetch on this same jar.
    let (agent, _proxy, _auth, desc) = match store.checkout_for_exchange(&id) {
        Ok(v) => v,
        Err(e) => {
            fail(e);
            return;
        }
    };
    store.set_status(&id, OAuthStatus::Validating);
    let result = tokio::task::spawn_blocking(move || {
        step_checktoken(&agent, &landing, &desc).map_err(|e| e.to_string())
    })
    .await;
    match result {
        Ok(Ok(bundle)) => {
            println!("[oauth:{id}] validated (accountType={})", bundle.account_type);
            store.store_validated(&id, bundle);
        }
        Ok(Err(e)) => fail(format!(
            "{e} — paste the /google/callback URL via the callback endpoint to retry on the same jar"
        )),
        Err(e) => fail(format!("exchange task failed: {e}")),
    }
}

/// Append the validated bundle to `data/google_oauth_tokens.jsonl` (0600 —
/// it is as powerful as the login). O_APPEND single write: concurrent
/// validations can't clobber each other (the old read-modify-write lost lines).
/// Best-effort; failures only log.
fn persist_validated(bundle: &ValidatedBundle) {
    let entry = serde_json::json!({
        "token": bundle.token,
        "accountType": bundle.account_type,
        "rid": bundle.rid,
        "mac": bundle.mac,
        "wk": bundle.wk,
        "validated_at": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
    });
    let mut line = serde_json::to_string(&entry).unwrap_or_default();
    if line.is_empty() {
        return;
    }
    line.push('\n');
    let path = "data/google_oauth_tokens.jsonl";
    let ok = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(line.as_bytes())
        })
        .is_ok();
    if ok {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
}
