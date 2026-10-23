//! Remote browser viewer for one OAuth session.
//!
//! Ports `remote-browser/backend` (`docs/ARCHITECTURE.md`, `PROTOCOL.md`,
//! `CLOAKBROWSER.md`) into Mori, scoped to a single login tab:
//!
//! - down: `Page.startScreencast {jpeg, q75, maxWidth:1280}` → per-session
//!   `broadcast` of JPEG bytes → `/oauth/google/:id/view` binary WS frames.
//!   Every frame is acked with the verbatim `params.sessionId` or the stream
//!   stalls (Obscura types it integer — passthrough covers both shapes).
//! - up: viewer JSON (`move/down/up/click/wheel/key/type`, same shapes as
//!   `PROTOCOL.md`) → `Input.dispatchMouseEvent / dispatchKeyEvent /
//!   insertText`. Frame px → page CSS px via live `Page.getLayoutMetrics`
//!   (10 s TTL). Printable keys travel `insertText` ONLY or chars duplicate.
//! - No `goto`: the tab is allowlisted to the authorize URL (server navigates
//!   once at open). No arbitrary browsing from the viewer.
//! - CloakBrowser path: dedicated tab via `Target.createTarget` on the
//!   browser WS, then direct page-WS drive (no session attach). Falls back to
//!   the profile's existing page when creation fails.
//!
//! Token detection stays headless (`watch_for_token` below) and works with or
//! without a viewer attached.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, Mutex, RwLock, oneshot};

use crate::google_oauth::{SeedCookie, extract_token_loose, extract_token_strict};

/// URL fragments → operator hint (mirrors `cloak_google_login.py:URL_HINTS`).
const URL_HINTS: &[(&str, &str)] = &[
    ("accounts.google.com", "log in to Google and approve consent in the window."),
    ("/logon-name", "new Google account — type a display name and submit."),
    ("profile-conflict", "choose link/merge for the conflicting account."),
    ("modalShow", "confirm/dismiss the popup."),
];

const CALLBACK_PATH: &str = "/google/callback";

/// Google's rejection page: the sign-in request was refused server-side
/// ("This browser or app may not be secure"). Detected so the session can
/// fail fast instead of looping on the identifier page until the timeout.
const REJECTED_PATH: &str = "/v3/signin/rejected";

/// Fallback stealth patch for providers we did **not** launch ourselves
/// (an external CloakBrowser manager): `navigator.webdriver` is redefined and
/// the replacement getter is made to look native, because a plain
/// `()=>false` getter is a visible tampering signature
/// (`Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver').get.toString()`
/// would return `()=>false` instead of `function get webdriver() { [native code] }`).
///
/// The preferred fix is the launch flag
/// (`--disable-blink-features=AutomationControlled`), which keeps the property
/// genuinely native — see [`crate::local_browser::launch_args`].
pub const STEALTH_SCRIPT: &str = r#"
(() => {
  try {
    const proto = Navigator.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'webdriver');
    if (!desc || !desc.get) return;
    const patched = function get webdriver() { return false; };
    Object.defineProperty(proto, 'webdriver', {
      get: patched,
      configurable: true,
      enumerable: desc.enumerable,
    });
    const nativeToString = Function.prototype.toString;
    Object.defineProperty(Function.prototype, 'toString', {
      value: new Proxy(nativeToString, {
        apply(target, thisArg, args) {
          if (thisArg === patched) return 'function get webdriver() { [native code] }';
          return Reflect.apply(target, thisArg, args);
        },
      }),
      writable: true,
      configurable: true,
    });
    window.__moriStealthPatched = true;
  } catch (e) {}
})();
"#;

/// Viewer → backend input messages (subset of remote-browser `FrontendMsg`;
/// coordinate fields mirror `PROTOCOL.md`: frame px + natural frame size).
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "t")]
pub enum ViewerMsg {
    #[serde(rename = "move")]
    Move { x: f64, y: f64, fw: Option<f64>, fh: Option<f64> },
    #[serde(rename = "down")]
    Down { x: f64, y: f64, #[serde(default = "default_button")] button: String, fw: Option<f64>, fh: Option<f64> },
    #[serde(rename = "up")]
    Up { x: f64, y: f64, #[serde(default = "default_button")] button: String, fw: Option<f64>, fh: Option<f64> },
    #[serde(rename = "click")]
    Click { x: f64, y: f64, #[serde(default = "default_button")] button: String, fw: Option<f64>, fh: Option<f64> },
    #[serde(rename = "wheel")]
    Wheel { x: f64, y: f64, dx: f64, dy: f64, fw: Option<f64>, fh: Option<f64> },
    #[serde(rename = "key")]
    Key { kind: String, key: String, #[serde(default)] code: String, #[serde(default)] text: String },
    #[serde(rename = "type")]
    Type { text: String },
}

fn default_button() -> String {
    "left".to_string()
}

/// Where the CDP endpoint comes from.
pub const PROVIDER_CLOAK: &str = "cloak";
pub const PROVIDER_LOCAL: &str = "local-chrome";

/// A CDP provider: an HTTP base for `/json/version` + `/json/list` and the
/// websocket URL rewrite rule (container-internal hosts).
#[derive(Debug, Clone)]
pub struct BrowserProvider {
    pub cdp_http: String,
    pub ws_host_override: Option<String>,
    /// `cloak` (external CloakBrowser manager) or `local-chrome` (launched by
    /// Mori itself — see [`crate::local_browser`]).
    pub source: String,
    /// Human-readable detail for the UI (browser path, profile dir, …).
    pub detail: String,
    /// The browser was launched with
    /// `--disable-blink-features=AutomationControlled`, so
    /// `navigator.webdriver` is natively `false` and no page patch is needed
    /// (a patch would leave a tampering signature).
    pub stealth_native: bool,
}

impl BrowserProvider {
    /// The externally managed CloakBrowser provider, when configured.
    /// Being *configured* is not being *usable* — [`resolve_provider`] checks
    /// reachability before picking it.
    pub fn cloak_from_env() -> Option<Self> {
        std::env::var("CLOAKBROWSER_CDP_HTTP")
            .ok()
            .filter(|v| !v.is_empty())
            .map(|cdp_http| Self {
                cdp_http,
                ws_host_override: std::env::var("CLOAKBROWSER_WS_HOST")
                    .ok()
                    .filter(|v| !v.is_empty()),
                source: PROVIDER_CLOAK.to_string(),
                detail: "CloakBrowser manager".to_string(),
                // We did not launch it: we cannot pass the launch flag, so the
                // page patch is the only option (made to look native).
                stealth_native: false,
            })
    }

    /// Local Chrome/Edge provider (launched on demand).
    pub fn local(exe: std::path::PathBuf, port: u16, profile: std::path::PathBuf) -> Self {
        Self {
            cdp_http: format!("http://127.0.0.1:{port}"),
            ws_host_override: None,
            source: PROVIDER_LOCAL.to_string(),
            detail: format!(
                "{} (profile {})",
                exe.display(),
                profile.display()
            ),
            stealth_native: true,
        }
    }
}

/// Pick a usable CDP provider.
///
/// Order: an explicitly configured CloakBrowser manager (only when it actually
/// answers — the common failure is "viewer open failed: io: Connection
/// refused" because the manager is not running), otherwise the local
/// Chrome/Edge, which Mori launches itself.
pub async fn resolve_provider() -> anyhow::Result<BrowserProvider> {
    let mut cloak_error: Option<String> = None;
    if let Some(cloak) = BrowserProvider::cloak_from_env() {
        let base = cloak.cdp_http.trim_end_matches('/').to_string();
        match get_json(format!("{base}/json/version")).await {
            Ok(_) => return Ok(cloak),
            Err(e) => {
                cloak_error = Some(format!(
                    "CLOAKBROWSER_CDP_HTTP={base} unreachable ({e})"
                ));
            }
        }
    }

    match crate::local_browser::ensure_started() {
        Ok((exe, port)) => {
            let profile = crate::local_browser::profile_dir();
            Ok(BrowserProvider::local(exe, port, profile))
        }
        Err(e) => Err(anyhow::anyhow!(
            "{}{}",
            cloak_error
                .map(|c| format!("{c}; "))
                .unwrap_or_default(),
            e
        )),
    }
}

fn blocking_get_json(url: &str) -> anyhow::Result<serde_json::Value> {
    let body = ureq::get(url)
        .header("Accept", "application/json")
        .call()?
        .body_mut()
        .read_to_string()?;
    Ok(serde_json::from_str(&body)?)
}

async fn get_json(url: String) -> anyhow::Result<serde_json::Value> {
    tokio::task::spawn_blocking(move || blocking_get_json(&url)).await?
}

/// Provider health: discovery reachable + a page WS resolvable.
#[derive(Debug, serde::Serialize)]
pub struct BrowserStatus {
    pub configured: bool,
    pub reachable: bool,
    pub page_ws_found: bool,
    pub detail: String,
    /// Which provider would be used: `cloak`, `local-chrome`, or `none`.
    pub provider: String,
    /// Browser executable backing the `local-chrome` provider.
    pub browser_path: Option<String>,
    /// Profile directory backing the `local-chrome` provider.
    pub profile_dir: Option<String>,
}

pub async fn browser_status() -> BrowserStatus {
    // 1. An explicitly configured CloakBrowser manager wins — but report it as
    //    unusable when it does not answer (the "Connection refused" case), so
    //    the UI can say that Mori falls back to the local browser.
    if let Some(cloak) = BrowserProvider::cloak_from_env() {
        let base = cloak.cdp_http.trim_end_matches('/').to_string();
        if get_json(format!("{base}/json/version")).await.is_err() {
            let (exe, profile) = crate::local_browser::describe();
            let detail = match &exe {
                Some(p) => format!(
                    "{base} unreachable - Mori falls back to the local browser ({p})"
                ),
                None => format!(
                    "{base} unreachable and {}",
                    crate::local_browser::missing_reason()
                ),
            };
            return BrowserStatus {
                configured: exe.is_some(),
                reachable: false,
                page_ws_found: false,
                detail,
                provider: if exe.is_some() {
                    PROVIDER_LOCAL.to_string()
                } else {
                    "none".to_string()
                },
                browser_path: exe,
                profile_dir: Some(profile),
            };
        }
        return match discover_page_ws(&cloak).await {
            Ok(_) => BrowserStatus {
                configured: true,
                reachable: true,
                page_ws_found: true,
                detail: "cloak profile reachable, page target present".to_string(),
                provider: PROVIDER_CLOAK.to_string(),
                browser_path: None,
                profile_dir: None,
            },
            Err(e) => BrowserStatus {
                configured: true,
                reachable: true,
                page_ws_found: false,
                detail: format!("no page target: {e}"),
                provider: PROVIDER_CLOAK.to_string(),
                browser_path: None,
                profile_dir: None,
            },
        };
    }

    // 2. Local browser — report only, never launch from a status call.
    let (exe, profile) = crate::local_browser::describe();
    match crate::local_browser::existing_session() {
        Some((_, port)) => {
            let provider = BrowserProvider {
                cdp_http: format!("http://127.0.0.1:{port}"),
                ws_host_override: None,
                source: PROVIDER_LOCAL.to_string(),
                detail: "local browser running".to_string(),
                stealth_native: true,
            };
            match discover_page_ws(&provider).await {
                Ok(_) => BrowserStatus {
                    configured: true,
                    reachable: true,
                    page_ws_found: true,
                    detail: format!("local browser running on port {port}"),
                    provider: PROVIDER_LOCAL.to_string(),
                    browser_path: exe,
                    profile_dir: Some(profile),
                },
                Err(e) => BrowserStatus {
                    configured: true,
                    reachable: true,
                    page_ws_found: false,
                    detail: format!("local browser running on port {port}: {e}"),
                    provider: PROVIDER_LOCAL.to_string(),
                    browser_path: exe,
                    profile_dir: Some(profile),
                },
            }
        }
        None => BrowserStatus {
            configured: exe.is_some(),
            reachable: false,
            page_ws_found: false,
            detail: match &exe {
                Some(p) => format!("{} found - launched automatically on login", p),
                None => crate::local_browser::missing_reason(),
            },
            provider: if exe.is_some() {
                PROVIDER_LOCAL.to_string()
            } else {
                "none".to_string()
            },
            browser_path: exe,
            profile_dir: Some(profile),
        },
    }
}

/// First `type == "page"` target's WS URL (existing-page fallback path).
pub async fn discover_page_ws(cfg: &BrowserProvider) -> anyhow::Result<String> {
    let base = cfg.cdp_http.trim_end_matches('/').to_string();
    let targets: serde_json::Value = get_json(format!("{base}/json/list")).await?;
    page_ws_from_list(&targets).map(|ws| rewrite_ws_host(&ws, cfg.ws_host_override.as_deref()))
}

fn page_ws_from_list(targets: &serde_json::Value) -> anyhow::Result<String> {
    targets
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
        .and_then(|t| t.get("webSocketDebuggerUrl").and_then(|v| v.as_str()))
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("no page target in /json/list"))
}

fn rewrite_ws_host(ws_url: &str, host_override: Option<&str>) -> String {
    let Some(host) = host_override else { return ws_url.to_string() };
    if let Some(rest) = ws_url.strip_prefix("ws://") {
        if let Some(idx) = rest.find('/') {
            return format!("ws://{}{}", host, &rest[idx..]);
        }
        return format!("ws://{host}");
    }
    if let Some(rest) = ws_url.strip_prefix("wss://") {
        if let Some(idx) = rest.find('/') {
            return format!("wss://{}{}", host, &rest[idx..]);
        }
        return format!("wss://{host}");
    }
    ws_url.to_string()
}

/// `Network.setCookie` params for one seed cookie. `url` pins the cookie to
/// the login host (Chromium derives domain/path from it — `Storage.setCookies`
/// instead expects full `Network.Cookie` objects and rejects partials).
fn cookie_param(c: &SeedCookie) -> serde_json::Value {
    serde_json::json!({
        "name": c.name,
        "value": c.value,
        "url": format!("https://{}/", c.domain.trim_start_matches('.')),
    })
}

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::Message,
>;

/// One CDP connection: id-routed commands plus an optional screencast loop.
struct RawConn {
    writer: Arc<Mutex<WsSink>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: AtomicU64,
    alive: AtomicBool,
}

impl RawConn {
    /// Connect and spawn the read loop. Command responses route by `id`;
    /// `Page.screencastFrame` events decode to `frames_tx` (when `Some`) and
    /// are acked with the verbatim `params.sessionId`.
    async fn connect(
        ws_url: &str,
        frames_tx: Option<broadcast::Sender<Vec<u8>>>,
    ) -> anyhow::Result<Arc<Self>> {
        let (stream, _) = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async(ws_url),
        )
        .await??;
        let (writer, mut reader) = stream.split();
        let conn = Arc::new(Self {
            writer: Arc::new(Mutex::new(writer)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
        });
        let loop_conn = conn.clone();
        tokio::spawn(async move {
            while let Some(msg) = reader.next().await {
                let text = match msg {
                    Ok(m) => {
                        if m.is_close() {
                            break;
                        }
                        match m.to_text() {
                            Ok(t) => t.to_string(),
                            Err(_) => continue,
                        }
                    }
                    Err(_) => break,
                };
                let v: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(id) = v.get("id").and_then(|i| i.as_u64())
                    && let Some(tx) = loop_conn.pending.lock().await.remove(&id) {
                        let _ = tx.send(v);
                        continue;
                    }
                if v.get("method").and_then(|m| m.as_str()) == Some("Page.screencastFrame") {
                    let params = &v["params"];
                    // Verbatim ack passthrough (integer or string — never coerce).
                    let cast_session = params.get("sessionId").cloned().unwrap_or(serde_json::Value::Null);
                    if let Some(tx) = &frames_tx
                        && let Some(data) = params.get("data").and_then(|d| d.as_str())
                            && let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                                let _ = tx.send(bytes);
                            }
                    let ack = serde_json::json!({
                        "id": loop_conn.next_id(),
                        "method": "Page.screencastFrameAck",
                        "params": { "sessionId": cast_session },
                    })
                    .to_string();
                    let mut w = loop_conn.writer.lock().await;
                    if w
                        .send(tokio_tungstenite::tungstenite::Message::Text(ack.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            loop_conn.alive.store(false, Ordering::Relaxed);
        });
        Ok(conn)
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn invoke(&self, method: &str, params: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let payload =
            serde_json::json!({"id": id, "method": method, "params": params}).to_string();
        if self
            .writer
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(payload.into()))
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            anyhow::bail!("cdp {method}: connection gone");
        }
        let resp = match tokio::time::timeout(Duration::from_secs(15), rx).await {
            Ok(Ok(resp)) => resp,
            // Timeout or sender gone (connection dropped): drop the pending
            // entry or the map grows one slot per failed call, forever.
            _ => {
                self.pending.lock().await.remove(&id);
                anyhow::bail!("cdp {method}: no response (timeout or connection gone)");
            }
        };
        if let Some(err) = resp.get("error") {
            anyhow::bail!("cdp {method} error: {err}");
        }
        Ok(resp)
    }

    /// Fire-and-forget (input events — no pending-map entry to leak).
    async fn send(&self, method: &str, params: serde_json::Value) -> anyhow::Result<()> {
        let id = self.next_id();
        let payload =
            serde_json::json!({"id": id, "method": method, "params": params}).to_string();
        self.writer
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(payload.into()))
            .await?;
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Politely close the WS so the read loop (which holds an `Arc` clone)
    /// terminates. Without this every temp browser-level connection leaks a
    /// task + socket for the process lifetime.
    async fn shutdown(&self) {
        let mut w = self.writer.lock().await;
        let _ = w
            .send(tokio_tungstenite::tungstenite::Message::Close(None))
            .await;
    }
}

/// Best-effort orphan-tab cleanup for failed `open()`s.
async fn best_effort_close_target(browser_ws_url: &str, target_id: &str) {
    if let Ok(browser) = RawConn::connect(browser_ws_url, None).await {
        let _ = browser
            .invoke("Target.closeTarget", serde_json::json!({ "targetId": target_id }))
            .await;
        browser.shutdown().await;
    }
}

/// A dedicated login tab: isolated target, seeded cookies, screencast frames.
pub struct RemoteViewer {
    page: Arc<RawConn>,
    browser_ws_url: String,
    target_id: Option<String>,
    frames_tx: broadcast::Sender<Vec<u8>>,
    viewport: RwLock<(f64, f64)>,
    viewport_at: Mutex<std::time::Instant>,
}

impl RemoteViewer {
    /// Create tab → seed cookies → screencast → navigate to `authorize_url`.
    /// Falls back to the profile's existing page when `Target.createTarget` fails.
    /// On failure the dedicated tab (if created) is closed so CloakBrowser
    /// doesn't accumulate orphan tabs across retries.
    pub async fn open(
        cfg: &BrowserProvider,
        cookies: &[SeedCookie],
        authorize_url: &str,
    ) -> anyhow::Result<Arc<Self>> {
        let base = cfg.cdp_http.trim_end_matches('/').to_string();
        let version: serde_json::Value = get_json(format!("{base}/json/version")).await?;
        let browser_ws = version
            .get("webSocketDebuggerUrl")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("no webSocketDebuggerUrl in /json/version"))?
            .to_string();
        let browser_ws = rewrite_ws_host(&browser_ws, cfg.ws_host_override.as_deref());
        let browser = RawConn::connect(&browser_ws, None).await?;

        // Isolated tab (one target per viewer). createTarget also navigates it,
        // but we navigate explicitly right after anyway.
        let target_id: Option<String> = browser
            .invoke("Target.createTarget", serde_json::json!({ "url": "about:blank" }))
            .await
            .ok()
            .and_then(|r| {
                r.get("result")
                    .and_then(|v| v.get("targetId"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            });

        let result =
            Self::open_inner(&base, cfg, &browser_ws, target_id.clone(), cookies, authorize_url).await;
        // Browser-level leg is done either way — shut it down or its read
        // loop lives forever holding an Arc.
        browser.shutdown().await;
        if result.is_err()
            && let Some(tid) = &target_id {
                best_effort_close_target(&browser_ws, tid).await;
            }
        result
    }

    async fn open_inner(
        base: &str,
        cfg: &BrowserProvider,
        browser_ws: &str,
        target_id: Option<String>,
        cookies: &[SeedCookie],
        authorize_url: &str,
    ) -> anyhow::Result<Arc<Self>> {

        // Resolve the new tab's page WS (poll: creation → listing races).
        let mut page_ws: Option<String> = None;
        if target_id.is_some() {
            for _ in 0..20 {
                if let Ok(list) = get_json(format!("{base}/json/list")).await {
                    if let Some(targets) = list.as_array() {
                        if let Some(t) = targets.iter().find(|t| {
                            t.get("id").and_then(|v| v.as_str()) == target_id.as_deref()
                        }) {
                            page_ws = t
                                .get("webSocketDebuggerUrl")
                                .and_then(|v| v.as_str())
                                .map(|u| rewrite_ws_host(u, cfg.ws_host_override.as_deref()));
                            if page_ws.is_some() {
                                break;
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        let page_ws = match page_ws {
            Some(u) => u,
            None => discover_page_ws(cfg).await?,
        };

        let (frames_tx, _) = broadcast::channel::<Vec<u8>>(8);
        let page = RawConn::connect(&page_ws, Some(frames_tx.clone())).await?;
        let viewer = Arc::new(Self {
            page,
            browser_ws_url: browser_ws.to_string(),
            target_id,
            frames_tx,
            viewport: RwLock::new((1280.0, 720.0)),
            viewport_at: Mutex::new(std::time::Instant::now()),
        });

        // Failure past this point must shut down the page WS or its read
        // loop (holding an Arc) leaks along with the socket.
        let setup = Self::setup_tab(&viewer, cookies, authorize_url, !cfg.stealth_native).await;
        if setup.is_err() {
            viewer.page.shutdown().await;
        }
        setup?;
        Ok(viewer)
    }

    /// Cookie seed → screencast → navigate. Split out so `open_inner` can
    /// tear down the page connection on failure.
    async fn setup_tab(
        viewer: &Self,
        cookies: &[SeedCookie],
        authorize_url: &str,
        inject_stealth: bool,
    ) -> anyhow::Result<()> {

        viewer.page.invoke("Network.enable", serde_json::json!({})).await?;
        for c in cookies {
            let result = viewer.page.invoke("Network.setCookie", cookie_param(c)).await?;
            if result
                .get("result")
                .and_then(|r| r.get("success"))
                != Some(&serde_json::Value::Bool(true))
            {
                anyhow::bail!("Network.setCookie rejected cookie {:?}", c.name);
            }
        }
        let t0 = std::time::Instant::now();
        // Screencast BEFORE navigate: a blank tab attaches faster than a
        // loading Google page, and the stream survives navigation. Fresh tabs
        // race "Not attached to an active page", so retry briefly.
        let _ = viewer.page.invoke("Page.enable", serde_json::json!({})).await;
        // Hide the automation marker before any page script runs — otherwise
        // Google refuses the sign-in ("This browser or app may not be secure").
        //
        // Only for browsers we did NOT launch: our own Chrome runs with
        // `--disable-blink-features=AutomationControlled`, which keeps the
        // property natively false. Patching it here would replace the native
        // getter with a JS function — a tampering signature that anti-bot
        // code can spot and that Google rejected the sign-in for.
        if inject_stealth {
            if let Err(e) = viewer
                .page
                .invoke(
                    "Page.addScriptToEvaluateOnNewDocument",
                    serde_json::json!({ "source": STEALTH_SCRIPT }),
                )
                .await
            {
                println!("[viewer] stealth injection failed: {e}");
            } else {
                println!("[viewer] stealth patch injected (provider without the launch flag)");
            }
        }
        let mut last_err = String::new();
        for _ in 0..12 {
            match viewer
                .page
                .invoke(
                    "Page.startScreencast",
                    serde_json::json!({
                        "format": "jpeg",
                        "quality": 75,
                        "maxWidth": 1280,
                        "everyNthFrame": 1,
                    }),
                )
                .await
            {
                Ok(_) => {
                    last_err.clear();
                    break;
                }
                Err(e) => {
                    last_err = e.to_string();
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }
        if !last_err.is_empty() {
            anyhow::bail!("Page.startScreencast: {last_err}");
        }
        println!("[viewer] screencast up in {:?}", t0.elapsed());
        viewer
            .page
            .invoke("Page.navigate", serde_json::json!({ "url": authorize_url }))
            .await?;
        println!("[viewer] navigate sent in {:?}", t0.elapsed());
        Ok(())
    }

    pub fn subscribe_frames(&self) -> broadcast::Receiver<Vec<u8>> {
        self.frames_tx.subscribe()
    }

    pub fn is_alive(&self) -> bool {
        self.page.is_alive()
    }

    async fn evaluate(&self, expression: &str) -> String {
        self.page
            .invoke(
                "Runtime.evaluate",
                serde_json::json!({ "expression": expression, "returnByValue": true }),
            )
            .await
            .ok()
            .and_then(|r| {
                r.get("result")
                    .and_then(|v| v.get("result"))
                    .and_then(|v| v.get("value"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default()
    }

    pub async fn current_url(&self) -> String {
        self.evaluate("location.href").await
    }

    pub async fn inner_text(&self) -> String {
        self.evaluate("document.body ? document.body.innerText : ''").await
    }

    pub async fn page_html(&self) -> String {
        self.evaluate("document.documentElement ? document.documentElement.outerHTML : ''").await
    }

    /// `navigator.webdriver` as the page sees it, plus whether the property
    /// still has its **native** getter.
    ///
    /// Google refuses the sign-in when the browser advertises automation. A
    /// patched getter (`()=>false` instead of `[native code]`) is a tampering
    /// signature and gets the sign-in rejected as well — so both are reported.
    pub async fn webdriver_probe(&self) -> Option<WebdriverProbe> {
        let raw = self
            .evaluate(
                "JSON.stringify({v:String(navigator.webdriver),d:(function(){var x=Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver');return x&&x.get?x.get.toString().slice(0,80):'absent';})(),m:!!window.__moriStealthPatched})",
            )
            .await;
        let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
        let value = v.get("v").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let desc = v.get("d").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let patched_marker = v.get("m").and_then(|x| x.as_bool()).unwrap_or(false);
        Some(WebdriverProbe {
            exposes_automation: value == "true",
            native_getter: desc.contains("native code") && !patched_marker,
            patched_marker,
        })
    }

    /// Cookies the browser holds for `urls` (`name`, `value`).
    ///
    /// The browser keeps its own cookie store (like the game's WebView2
    /// store) while Mori's HTTP agent keeps a second one. When the callback
    /// completes inside the browser, the landing cookie has to be copied over
    /// before the validation POST can succeed — that is the "jar split" the
    /// docs describe.
    pub async fn cookies_for(&self, urls: &[&str]) -> Vec<(String, String)> {
        let resp = self
            .page
            .invoke(
                "Network.getCookies",
                serde_json::json!({ "urls": urls }),
            )
            .await;
        let cookies: Option<Vec<(String, String)>> = match resp {
            Ok(v) => v
                .get("result")
                .and_then(|r| r.get("cookies"))
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| {
                            let n = c.get("name").and_then(|x| x.as_str())?;
                            let val = c.get("value").and_then(|x| x.as_str())?;
                            Some((n.to_string(), val.to_string()))
                        })
                        .collect()
                }),
            Err(_) => None,
        };
        cookies.unwrap_or_default()
    }

    /// Best-effort teardown: stop screencast, close the dedicated tab, shut
    /// down our page WS. Always shuts down the socket — even on the fallback
    /// path (no `target_id`) where there is no tab to close.
    pub async fn close(&self) -> anyhow::Result<()> {
        let _ = self.page.invoke("Page.stopScreencast", serde_json::json!({})).await;
        if let Some(target_id) = &self.target_id
            && let Ok(browser) = RawConn::connect(&self.browser_ws_url, None).await {
                let _ = browser
                    .invoke("Target.closeTarget", serde_json::json!({ "targetId": target_id }))
                    .await;
                browser.shutdown().await;
            }
        self.page.shutdown().await;
        Ok(())
    }

    /// Page CSS viewport, refreshed at most every 10 s. Falls back to last known.
    async fn viewport(&self) -> (f64, f64) {
        {
            let at = self.viewport_at.lock().await;
            if at.elapsed() < Duration::from_secs(10) {
                return *self.viewport.read().await;
            }
        }
        if let Ok(resp) = self.page.invoke("Page.getLayoutMetrics", serde_json::json!({})).await {
            let lv = &resp["result"]["cssLayoutViewport"];
            let w = lv
                .get("clientWidth")
                .and_then(|v| v.as_f64())
                .or_else(|| {
                    resp["result"]["layoutViewport"].get("clientWidth").and_then(|v| v.as_f64())
                });
            let h = lv
                .get("clientHeight")
                .and_then(|v| v.as_f64())
                .or_else(|| {
                    resp["result"]["layoutViewport"].get("clientHeight").and_then(|v| v.as_f64())
                });
            if let (Some(w), Some(h)) = (w, h)
                && w > 0.0
                && h > 0.0 {
                    *self.viewport.write().await = (w, h);
                    *self.viewport_at.lock().await = std::time::Instant::now();
                    return (w, h);
                }
        }
        *self.viewport.read().await
    }

    /// Frame px (what the viewer shows) → page CSS px.
    async fn scale(&self, x: f64, y: f64, fw: Option<f64>, fh: Option<f64>) -> (f64, f64) {
        let (vw, vh) = self.viewport().await;
        let sx = match fw {
            Some(fw) if fw > 0.0 => vw / fw,
            _ => 1.0,
        };
        let sy = match fh {
            Some(fh) if fh > 0.0 => vh / fh,
            _ => 1.0,
        };
        (x * sx, y * sy)
    }

    fn cdp_button(button: &str) -> &'static str {
        match button {
            "middle" => "middle",
            "right" => "right",
            _ => "left",
        }
    }

    /// Translate one viewer message into CDP `Input.*` commands.
    pub async fn handle_input(&self, msg: ViewerMsg) -> anyhow::Result<()> {
        match msg {
            ViewerMsg::Move { x, y, fw, fh } => {
                let (x, y) = self.scale(x, y, fw, fh).await;
                self.page.send("Input.dispatchMouseEvent", serde_json::json!({"type": "mouseMoved", "x": x, "y": y})).await?;
            }
            ViewerMsg::Down { x, y, button, fw, fh } => {
                let (x, y) = self.scale(x, y, fw, fh).await;
                let b = Self::cdp_button(&button);
                self.page.send("Input.dispatchMouseEvent", serde_json::json!({"type": "mousePressed", "x": x, "y": y, "button": b, "clickCount": 1})).await?;
            }
            ViewerMsg::Up { x, y, button, fw, fh } => {
                let (x, y) = self.scale(x, y, fw, fh).await;
                let b = Self::cdp_button(&button);
                self.page.send("Input.dispatchMouseEvent", serde_json::json!({"type": "mouseReleased", "x": x, "y": y, "button": b, "clickCount": 1})).await?;
            }
            ViewerMsg::Click { x, y, button, fw, fh } => {
                let (x, y) = self.scale(x, y, fw, fh).await;
                let b = Self::cdp_button(&button);
                self.page.send("Input.dispatchMouseEvent", serde_json::json!({"type": "mousePressed", "x": x, "y": y, "button": b, "clickCount": 1})).await?;
                self.page.send("Input.dispatchMouseEvent", serde_json::json!({"type": "mouseReleased", "x": x, "y": y, "button": b, "clickCount": 1})).await?;
            }
            ViewerMsg::Wheel { x, y, dx, dy, fw, fh } => {
                let (x, y) = self.scale(x, y, fw, fh).await;
                self.page.send("Input.dispatchMouseEvent", serde_json::json!({"type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy})).await?;
            }
            ViewerMsg::Key { kind, key, code, text } => {
                if kind == "down" {
                    if text.chars().count() == 1 {
                        // Printable → rawKeyDown + char (matches reference POC).
                        self.page.send("Input.dispatchKeyEvent", serde_json::json!({"type": "rawKeyDown", "key": key, "code": code, "text": text, "unmodifiedText": text})).await?;
                        self.page.send("Input.dispatchKeyEvent", serde_json::json!({"type": "char", "key": key, "code": code, "text": text, "unmodifiedText": text})).await?;
                    } else {
                        let (vk, windows_code) = windows_key_code(&key, &code);
                        self.page.send("Input.dispatchKeyEvent", serde_json::json!({"type": "rawKeyDown", "key": key, "code": code, "windowsVirtualKeyCode": windows_code, "nativeVirtualKeyCode": vk})).await?;
                    }
                } else {
                    let (vk, windows_code) = windows_key_code(&key, &code);
                    self.page.send("Input.dispatchKeyEvent", serde_json::json!({"type": "keyUp", "key": key, "code": code, "windowsVirtualKeyCode": windows_code, "nativeVirtualKeyCode": vk})).await?;
                }
            }
            ViewerMsg::Type { text } => {
                self.page.send("Input.insertText", serde_json::json!({ "text": text })).await?;
            }
        }
        Ok(())
    }
}

/// Minimal key → virtual-key-code map for non-printable keys.
fn windows_key_code(key: &str, code: &str) -> (u32, u32) {
    let vk = match key {
        "Enter" => 13,
        "Tab" => 9,
        "Backspace" => 8,
        "Escape" => 27,
        "ArrowLeft" => 37,
        "ArrowUp" => 38,
        "ArrowRight" => 39,
        "ArrowDown" => 40,
        "Delete" => 46,
        "Home" => 36,
        "End" => 35,
        _ if code.starts_with('F') => 0,
        _ => 0,
    };
    (vk, vk)
}

/// What the page sees of the automation marker.
#[derive(Debug, Clone, Copy)]
pub struct WebdriverProbe {
    /// `navigator.webdriver === true` — Google rejects the sign-in.
    pub exposes_automation: bool,
    /// The property still has its native getter (no tampering signature).
    pub native_getter: bool,
    /// The stealth patch was applied to this page.
    pub patched_marker: bool,
}

/// What the watcher saw before it gave up.
#[derive(Debug, Default, Clone)]
pub struct WatchOutcome {
    /// Landing token (strict JSON or the callback-path fallback).
    pub token: Option<String>,
    /// The `/google/callback?code=...&state=...` URL the browser landed on.
    /// Replaying it on Mori's own cookie jar keeps the exchange on a single
    /// jar (no "jar split").
    pub callback_url: Option<String>,
    /// Google refused the sign-in (`/v3/signin/rejected`).
    pub rejected: bool,
}

/// Poll the tab for the strict success JSON until timeout.
/// Progress lines go to `log_tx`. Returns the landing token + callback URL.
pub async fn watch_for_token(
    viewer: &RemoteViewer,
    timeout_secs: u64,
    log_tx: &tokio::sync::mpsc::UnboundedSender<String>,
) -> WatchOutcome {
    let log = |msg: String| {
        let _ = log_tx.send(msg);
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut seen: Option<String> = None;
    let mut hinted: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut last_heartbeat = tokio::time::Instant::now();
    let mut outcome = WatchOutcome::default();
    let mut flag_logged = false;
    while tokio::time::Instant::now() < deadline {
        // Tab gone (closed externally, cloak restarted): fail fast instead of
        // polling a dead socket until the full timeout.
        if !viewer.is_alive() {
            log("[browser] tab connection lost - restart with a fresh mint".to_string());
            return outcome;
        }
        let url = viewer.current_url().await;
        if !url.is_empty() && seen.as_ref() != Some(&url) {
            seen = Some(url.clone());
            log(format!("[browser] nav {:.200}", url));
            for (frag, hint) in URL_HINTS {
                if url.contains(frag) && hinted.insert(frag) {
                    log(format!("[browser] hint: {hint}"));
                }
            }
        }
        // Remember the callback URL as soon as the browser lands on it: it
        // carries the Google `code` that Mori replays on its own jar.
        if url.contains(CALLBACK_PATH)
            && url.contains("code=")
            && outcome.callback_url.is_none()
        {
            log("[browser] callback URL captured".to_string());
            outcome.callback_url = Some(url.clone());
        }
        // One-shot diagnostic: Google rejects the sign-in when the page looks
        // automated (`navigator.webdriver === true`) or when the property
        // was patched (tampering signature).
        if !flag_logged && url.contains("accounts.google.com") {
            flag_logged = true;
            match viewer.webdriver_probe().await {
                Some(p) if p.exposes_automation => log(
                    "[browser] WARNING: navigator.webdriver=true - Google will reject the sign-in"
                        .to_string(),
                ),
                Some(p) if p.native_getter => {
                    log("[browser] navigator.webdriver=false (native getter, clean)".to_string())
                }
                Some(p) => log(format!(
                    "[browser] navigator.webdriver=false but the getter is PATCHED{} - Google may still reject the sign-in",
                    if p.patched_marker { " (stealth patch applied)" } else { "" }
                )),
                None => {}
            }
        }
        // Google refused the sign-in: stop instead of bouncing between the
        // identifier page and the rejection page until the timeout.
        if url.contains(REJECTED_PATH) && !outcome.rejected {
            outcome.rejected = true;
            log("[browser] Google rejected this browser context (/v3/signin/rejected)".to_string());
            return outcome;
        }
        if let Some(token) = extract_token_strict(&viewer.inner_text().await) {
            log("[browser] success JSON found".to_string());
            outcome.token = Some(token);
            return outcome;
        }
        // Loose fallback, callback path only (report 07 §4).
        if url.contains(CALLBACK_PATH)
            && let Some(token) = extract_token_loose(&viewer.page_html().await, &url) {
                log("[browser] success JSON found (callback fallback)".to_string());
                outcome.token = Some(token);
                return outcome;
            }
        if last_heartbeat.elapsed() > Duration::from_secs(20) {
            last_heartbeat = tokio::time::Instant::now();
            log(format!("[browser] waiting… current: {:.160}", url));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_host_rewrite() {
        assert_eq!(
            rewrite_ws_host("ws://172-18-0-2:8080/cdp/devtools/page/1", Some("localhost:8080")),
            "ws://localhost:8080/cdp/devtools/page/1"
        );
        assert_eq!(rewrite_ws_host("ws://a:1/x", None), "ws://a:1/x");
    }

    #[test]
    fn cookie_param_pins_login_host() {
        let c = SeedCookie {
            name: "growtopia_game_session".to_string(),
            value: "abc123".to_string(),
            domain: "login.growtopiagame.com".to_string(),
            path: "/".to_string(),
        };
        let p = cookie_param(&c);
        assert_eq!(p["name"], "growtopia_game_session");
        assert_eq!(p["value"], "abc123");
        assert_eq!(p["url"], "https://login.growtopiagame.com/");
    }

    #[test]
    fn stealth_script_overrides_webdriver() {
        assert!(STEALTH_SCRIPT.contains("'webdriver'"));
        // The replacement getter must look native, otherwise anti-bot code
        // spots the tampering (Google rejected the sign-in for it).
        assert!(STEALTH_SCRIPT.contains("native code"));
        assert!(STEALTH_SCRIPT.contains("__moriStealthPatched"));
    }

    #[test]
    fn local_provider_is_native_cloak_is_patched() {
        // We launch the local browser with the stealth flag -> no page patch.
        let local = BrowserProvider::local(
            std::path::PathBuf::from("chrome.exe"),
            9222,
            std::path::PathBuf::from("data/chrome-profile"),
        );
        assert!(local.stealth_native);

        // An external manager was not launched by us -> the patch is needed.
        unsafe {
            std::env::set_var("CLOAKBROWSER_CDP_HTTP", "http://localhost:8080/cdp");
        }
        let cloak = BrowserProvider::cloak_from_env().expect("cloak");
        assert!(!cloak.stealth_native);
        unsafe {
            std::env::remove_var("CLOAKBROWSER_CDP_HTTP");
        }
    }

    #[test]
    fn cloak_provider_reads_env() {
        unsafe {
            std::env::set_var("CLOAKBROWSER_CDP_HTTP", "http://localhost:8080/cdp");
            std::env::set_var("CLOAKBROWSER_WS_HOST", "localhost:8080");
        }
        let p = BrowserProvider::cloak_from_env().expect("provider");
        assert_eq!(p.source, PROVIDER_CLOAK);
        assert_eq!(p.cdp_http, "http://localhost:8080/cdp");
        assert_eq!(p.ws_host_override.as_deref(), Some("localhost:8080"));
    }

    #[test]
    fn viewer_msg_shapes_match_protocol() {
        // move/down/click/wheel carry frame px + natural frame size.
        let m: ViewerMsg =
            serde_json::from_str(r#"{"t":"move","x":10,"y":20,"fw":1280,"fh":631}"#).unwrap();
        assert!(matches!(m, ViewerMsg::Move { .. }));
        let m: ViewerMsg = serde_json::from_str(r#"{"t":"type","text":"a@b.c"}"#).unwrap();
        assert!(matches!(m, ViewerMsg::Type { .. }));
        let m: ViewerMsg =
            serde_json::from_str(r#"{"t":"key","kind":"down","key":"Enter","code":"Enter"}"#).unwrap();
        assert!(matches!(m, ViewerMsg::Key { .. }));
    }
}
