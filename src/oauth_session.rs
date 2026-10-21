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
    MintedSession, OAuthError, SeedCookie, ValidatedBundle, import_cookies, mint_with_backoff,
    step_callback, step_checktoken,
};
use crate::remote_view::{self, RemoteViewer, ViewerMsg};

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
    /// OAuth `state` of the authorize URL — the handle the browser extension
    /// uses to find the session it belongs to.
    state: String,
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
            OAuthError::Retryable(m) => format!("login mint failed after 3 attempts: {m}"),
            OAuthError::Fatal(m) => m,
        })?;

        let id = uuid::Uuid::new_v4().to_string();
        let pending = PendingOAuth {
            created_at: now_secs(),
            agent: minted.agent,
            proxy_url: proxy_url.clone(),
            authorize_url: minted.authorize.url.clone(),
            state: minted.authorize.state.clone(),
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

        // Background browser leg (primary path). A CDP provider is resolved
        // inside the leg: the external CloakBrowser manager when it answers,
        // otherwise the local Chrome/Edge that Mori launches itself. The
        // manual endpoints stay usable regardless.
        self.set_status(&id, OAuthStatus::Watching);
        let store = self.clone();
        tokio::spawn(async move {
            run_browser_leg(store, id, watch_timeout_secs).await;
        });
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

    /// Find the session that owns an OAuth `state`.
    ///
    /// The browser extension sees the landing page (with the `state` in its
    /// URL) and asks which Mori session it belongs to.
    pub fn lookup_by_state(&self, state: &str) -> Option<(String, String)> {
        if state.is_empty() {
            return None;
        }
        let inner = self.inner.lock().ok()?;
        let (id, desc_raw) = inner
            .iter()
            .find(|(_, p)| !p.state.is_empty() && p.state == state)
            .map(|(k, p)| (k.clone(), p.desc_raw.clone()))?;
        Some((id, desc_raw))
    }

    /// Accept a landing token reported by the browser extension.
    ///
    /// The extension ran the `checktoken` POST inside the login page, so the
    /// server already accepted it on the right session; the reported token is
    /// the session token. The bundle is completed with the `rid`/`mac`/`wk`
    /// of the descriptor this session was minted with.
    pub fn report_landing(
        &self,
        id: &str,
        token: &str,
        account_type: &str,
    ) -> Result<OAuthSessionView, String> {
        let token = token.trim();
        if token.is_empty() {
            return Err("token required".to_string());
        }
        let (rid, mac, wk) = {
            let inner = self.inner.lock().map_err(|_| "store lock poisoned".to_string())?;
            let p = inner
                .get(id)
                .ok_or_else(|| "unknown oauth session".to_string())?;
            if matches!(p.status, OAuthStatus::Validated { .. }) {
                return Err("session already validated".to_string());
            }
            (p.rid.clone(), p.mac.clone(), p.wk.clone())
        };
        let bundle = ValidatedBundle {
            token: token.to_string(),
            account_type: if account_type.is_empty() {
                "google".to_string()
            } else {
                account_type.to_string()
            },
            rid,
            mac,
            wk,
        };
        self.store_validated(id, bundle);
        self.get(id).ok_or_else(|| "session vanished".to_string())
    }

    /// Open the authorize URL in the user's default browser.
    ///
    /// That browser is started by the OS, so it carries no automation flags
    /// and Google accepts the sign-in. The result comes back through the
    /// browser extension or a manual token paste.
    pub fn open_in_system_browser(&self, id: &str) -> Result<(), String> {
        let url = self.authorize_url(id)?;
        crate::sysbrowser::open_default_browser(&url).map_err(|e| e.to_string())
    }

    /// Open the authorize URL in a **bare** Chrome: a completely ordinary
    /// browser, launched by Mori but without a DevTools port and without any
    /// automation flag (so Google cannot tell it apart from a human's
    /// browser). Mori cannot drive it — the sign-in is finished by hand and
    /// the result comes back through the helper extension or a pasted token.
    pub fn open_in_bare_browser(&self, id: &str) -> Result<String, String> {
        let url = self.authorize_url(id)?;
        let profile =
            crate::local_browser::open_bare_browser(&url).map_err(|e| e.to_string())?;
        Ok(profile.display().to_string())
    }

    /// The authorize URL of a session.
    fn authorize_url(&self, id: &str) -> Result<String, String> {
        let inner = self.inner.lock().map_err(|_| "store lock poisoned".to_string())?;
        let p = inner
            .get(id)
            .ok_or_else(|| "unknown oauth session".to_string())?;
        Ok(p.authorize_url.clone())
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
    // A usable CDP provider: the external CloakBrowser manager when it
    // answers, otherwise the local Chrome/Edge Mori launches itself. When
    // neither is available the session stays on the manual endpoints.
    let provider = match remote_view::resolve_provider().await {
        Ok(p) => p,
        Err(e) => {
            store.set_status(&id, OAuthStatus::WaitingBrowser);
            println!(
                "[oauth:{id}] no browser provider ({e}) - use the manual callback/token fields"
            );
            return;
        }
    };
    let view = match store.get(&id) {
        Some(v) => v,
        None => return,
    };

    let viewer = match RemoteViewer::open(&provider, &view.seed_cookies, &view.authorize_url).await {
        Ok(v) => v,
        Err(e) => {
            fail(format!("viewer open failed: {e}"));
            return;
        }
    };
    store.attach_viewer(&id, viewer.clone());
    println!(
        "[oauth:{id}] login tab ready ({}: {}) - open it from the Google tab (Open browser)",
        provider.source, provider.detail
    );

    let (log_tx, mut log_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let print_id = id.clone();
    tokio::spawn(async move {
        while let Some(msg) = log_rx.recv().await {
            println!("[oauth:{print_id}] {msg}");
        }
    });
    let outcome = remote_view::watch_for_token(&viewer, watch_timeout_secs, &log_tx).await;
    if outcome.rejected {
        fail(
            "Google rejected this browser context (/v3/signin/rejected - \"This browser or app \
             may not be secure\"). Close every Chrome window that is still open (the stealth flag \
             is a launch flag, so an old instance still carries the automation marker), then \
             Start again. If it keeps happening use \"Open in my browser\" (no automation at all) \
             or \"Open in a clean Chrome\"."
                .to_string(),
        );
        return;
    }
    if outcome.token.is_none() && outcome.callback_url.is_none() {
        fail("no success token seen before timeout - state likely spent, restart with fresh mint".to_string());
        return;
    }

    // Validate on the mint agent (single jar). The browser completed the
    // callback in its own cookie store, so the landing token has to be
    // validated on a jar that holds the same session cookies; when the server
    // rejects it, the browser's cookies are copied over and the validation is
    // retried (jar split).
    let (agent, _proxy, authorize_url, desc) = match store.checkout_for_exchange(&id) {
        Ok(v) => v,
        Err(e) => {
            fail(e);
            return;
        }
    };
    store.set_status(&id, OAuthStatus::Validating);

    // Browser-side cookies (for the jar-split retry).
    let browser_cookies = viewer
        .cookies_for(&["https://login.growtopiagame.com/"])
        .await;
    let browser_token = outcome.token.clone();
    let callback_url = outcome.callback_url.clone();

    let result = tokio::task::spawn_blocking(move || {
        // 1. Landing token rendered by the browser (the normal case).
        // 2. Only when the browser produced no token: replay the callback URL
        //    on Mori's own jar. The Google `code` is single-use, so this must
        //    not run after the browser already exchanged it.
        let landing = match &browser_token {
            Some(t) => t.clone(),
            None => {
                let cb = callback_url
                    .as_ref()
                    .ok_or_else(|| "no landing token and no callback URL".to_string())?;
                step_callback(&agent, cb, &authorize_url).map_err(|e| e.to_string())?
            }
        };
        match step_checktoken(&agent, &landing, &desc) {
            Ok(bundle) => Ok(bundle),
            Err(first) => {
                // Jar split: copy the browser's cookies into our jar and retry
                // with the same landing token.
                if browser_cookies.is_empty() {
                    return Err(first.to_string());
                }
                import_cookies(&agent, &browser_cookies);
                step_checktoken(&agent, &landing, &desc).map_err(|e| {
                    format!("{e} (after syncing {} browser cookie(s): {first})", browser_cookies.len())
                })
            }
        }
    })
    .await;
    match result {
        Ok(Ok(bundle)) => {
            println!("[oauth:{id}] validated (accountType={})", bundle.account_type);
            store.store_validated(&id, bundle);
        }
        Ok(Err(e)) => fail(format!(
            "{e} - paste the /google/callback URL via the callback endpoint to retry on the same jar"
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(state: &str) -> PendingOAuth {
        PendingOAuth {
            created_at: 0,
            agent: ureq::Agent::new_with_config(ureq::config::Config::builder().build()),
            proxy_url: None,
            authorize_url: format!("https://accounts.google.com/o/oauth2/auth?state={state}"),
            state: state.to_string(),
            seed_cookies: Vec::new(),
            desc_raw: "klv|1".to_string(),
            rid: "RID".to_string(),
            mac: "MAC".to_string(),
            wk: "WK".to_string(),
            status: OAuthStatus::WaitingBrowser,
            validated: None,
            viewer: None,
        }
    }

    fn store_with(id: &str, state: &str) -> OAuthStore {
        let store = OAuthStore::new();
        store
            .inner
            .lock()
            .unwrap()
            .insert(id.to_string(), pending(state));
        store
    }

    #[test]
    fn lookup_by_state_finds_the_session() {
        let store = store_with("sess-1", "abc+def");
        // The extension sends the decoded state (URLSearchParams decodes %2B).
        let (found, client_data) = store.lookup_by_state("abc+def").expect("session");
        assert_eq!(found, "sess-1");
        assert_eq!(client_data, "klv|1");
        assert!(store.lookup_by_state("other").is_none());
        assert!(store.lookup_by_state("").is_none());
    }

    #[test]
    fn report_landing_completes_the_bundle() {
        let store = store_with("sess-2", "x");
        let view = store.report_landing("sess-2", "TOKEN", "google").expect("validated");
        assert!(matches!(view.status, OAuthStatus::Validated { .. }));
        assert_eq!(view.ltoken.as_deref(), Some("TOKEN|RID|MAC|WK"));
        // A second report is rejected (the session is already terminal).
        assert!(store.report_landing("sess-2", "TOKEN2", "google").is_err());
    }

    #[test]
    fn report_landing_needs_a_token() {
        let store = store_with("sess-3", "y");
        assert!(store.report_landing("sess-3", "  ", "google").is_err());
        assert!(store.report_landing("unknown", "T", "google").is_err());
    }
}
