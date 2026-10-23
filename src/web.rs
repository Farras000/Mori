use axum::{
    Router,
    body::Body,
    extract::{Path, Query, Request, State, WebSocketUpgrade},
    extract::ws::{Message, WebSocket},
    http::{StatusCode, Method},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::net::{ToSocketAddrs, SocketAddr};

use crate::auth::AuthState;
use crate::bot::Socks5Config;
use crate::bot_manager::{BotInfo, BotManager};
use crate::bot_state::{BotCommand, BotDelays, BotState};
use crate::events::WsTx;
use crate::items::ItemInfo;
use crate::oauth_session::{OAuthSessionView, OAuthStore};
use crate::proxy_test::{ProxyTestResult, run_proxy_test};

pub type SharedManager = Arc<Mutex<BotManager>>;

#[derive(Clone)]
pub struct AppState {
    pub manager: SharedManager,
    pub ws_tx:   WsTx,
    pub auth:    AuthState,
    pub oauth:   OAuthStore,
}

fn proxy_from_parts(
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
) -> Option<Socks5Config> {
    let (host, port) = (host?, port?);
    let addr: SocketAddr = format!("{host}:{port}").parse().ok().or_else(|| {
        format!("{host}:{port}").to_socket_addrs().ok().and_then(|mut a| a.next())
    })?;
    Some(Socks5Config { proxy_addr: addr, username, password })
}

// ── Auth middleware ────────────────────────────────────────────────────────────

/// Local IPv4 addresses (for "open this on your phone" hints).
///
/// Uses the standard trick: connect a UDP socket "outwards" (no traffic is
/// sent) and ask the OS which local address it would use.
fn lan_addresses() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        let _ = sock.connect("8.8.8.8:80");
        if let Ok(addr) = sock.local_addr()
            && !addr.ip().is_loopback()
            && addr.ip().is_ipv4()
        {
            out.push(addr.ip().to_string());
        }
    }
    out
}

/// Extract the Bearer token from the `Authorization` header.
fn extract_bearer(req: &Request) -> Option<String> {
    let hdr = req.headers().get("Authorization")?.to_str().ok()?;
    hdr.strip_prefix("Bearer ").map(str::to_owned)
}

async fn auth_middleware(
    State(s): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();
    if path.starts_with("/auth/")
        || path == "/"
        || path.starts_with("/assets/")
        || path.starts_with("/docs")
        || path == "/favicon.svg"
        || path == "/icons.svg"
        || path.starts_with("/growtopia-cdn/")
    {
        return next.run(req).await;
    }

    // WebSocket token is passed as a query param `?token=…`
    // (both the event socket and per-session browser viewers).
    if path == "/ws" || (path.starts_with("/oauth/google/") && path.ends_with("/view")) {
        let token = req.uri().query()
            .and_then(|q| {
                url::form_urlencoded::parse(q.as_bytes())
                    .find(|(k, _)| k == "token")
                    .map(|(_, v)| v.into_owned())
            });
        if let Some(t) = token {
            if s.auth.validate_token(&t) {
                return next.run(req).await;
            }
        }
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // All other routes need a valid Bearer token.
    if let Some(token) = extract_bearer(&req) {
        if s.auth.validate_token(&token) {
            return next.run(req).await;
        }
    }
    StatusCode::UNAUTHORIZED.into_response()
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

/// GET /auth/status  →  { registered: bool }
async fn auth_status(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "registered": s.auth.is_registered() }))
}

#[derive(Deserialize)]
struct SetupRequest {
    password: String,
}

/// POST /auth/setup  →  registers the single user (only works once)
async fn auth_setup(
    State(s): State<AppState>,
    Json(req): Json<SetupRequest>,
) -> Response {
    if s.auth.is_registered() {
        return (StatusCode::CONFLICT, Json(serde_json::json!({ "error": "already registered" }))).into_response();
    }
    match s.auth.register(&req.password) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e.to_string() })),
        ).into_response(),
    }
}

#[derive(Deserialize)]
struct LoginRequest {
    password: String,
}

/// POST /auth/login  →  { token: "…" }
async fn auth_login(
    State(s): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Response {
    match s.auth.login(&req.password) {
        Some(token) => Json(serde_json::json!({ "token": token })).into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid password" })),
        ).into_response(),
    }
}

/// POST /auth/logout
async fn auth_logout(State(s): State<AppState>, headers: axum::http::HeaderMap) -> StatusCode {
    // Only the caller's own session is dropped - a phone stays logged in.
    let token = headers
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    s.auth.logout(token);
    StatusCode::NO_CONTENT
}

// ── Bot handlers ───────────────────────────────────────────────────────────────

async fn list_bots(State(s): State<AppState>) -> Json<Vec<BotInfo>> {
    let mgr = s.manager.lock().unwrap();
    // Keep the stored configuration in sync with the live bots (delays,
    // proxy, collect flags - whatever changed through the UI, gRPC or Lua).
    mgr.sync_configs();
    Json(mgr.list())
}

// ── Saved bot configurations (data/bots.json) ─────────────────────────────────

/// POST /bots/saved/{id}/restart — stop the running bot (if any) and start
/// it again from its stored configuration (same id, same settings).
async fn restart_saved_bot(
    State(s): State<AppState>,
    Path(id): Path<u32>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    {
        let mut mgr = s.manager.lock().unwrap();
        if mgr.store.get(id).is_none() {
            return Err(StatusCode::NOT_FOUND);
        }
        if mgr.bots.contains_key(&id) {
            let reason = format!("restart (POST /bots/saved/{id}/restart)");
            mgr.stop(id, &reason);
        }
    }
    // Give the old connection a moment to close: logging the same account in
    // twice at once is what triggers Growtopia's "too many logins".
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let mut mgr = s.manager.lock().unwrap();
    let Some(cfg) = mgr.store.get(id) else {
        return Err(StatusCode::NOT_FOUND);
    };
    let bot_id = mgr.spawn_saved(&cfg);
    Ok(Json(serde_json::json!({ "id": bot_id })))
}

/// GET /bots/saved — stored bot configurations (without the secrets).
async fn list_saved_bots(State(s): State<AppState>) -> Json<serde_json::Value> {
    let mgr = s.manager.lock().unwrap();
    let running: Vec<u32> = mgr.bots.keys().copied().collect();
    let items: Vec<serde_json::Value> = mgr
        .store
        .list()
        .iter()
        .map(|c| {
            let mut v = c.public();
            if let Some(obj) = v.as_object_mut() {
                obj.insert("running".to_string(), serde_json::json!(running.contains(&c.id)));
            }
            v
        })
        .collect();
    Json(serde_json::json!({ "bots": items }))
}

/// POST /bots/saved/{id}/spawn — start a stored bot (same id, same settings).
async fn spawn_saved_bot(
    State(s): State<AppState>,
    Path(id): Path<u32>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let mut mgr = s.manager.lock().unwrap();
    let Some(cfg) = mgr.store.get(id) else {
        return Err(StatusCode::NOT_FOUND);
    };
    if mgr.bots.contains_key(&id) {
        return Err(StatusCode::CONFLICT);
    }
    let bot_id = mgr.spawn_saved(&cfg);
    Ok(Json(serde_json::json!({ "id": bot_id })))
}

#[derive(Deserialize)]
struct SavedBotPatch {
    #[serde(default)]
    auto_spawn: Option<bool>,
}

/// PATCH /bots/saved/{id} — toggle auto-start.
async fn patch_saved_bot(
    State(s): State<AppState>,
    Path(id): Path<u32>,
    Json(req): Json<SavedBotPatch>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let mgr = s.manager.lock().unwrap();
    if mgr.store.get(id).is_none() {
        return Err(StatusCode::NOT_FOUND);
    }
    if let Some(auto) = req.auto_spawn {
        mgr.store.update(id, |c| c.auto_spawn = auto);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// DELETE /bots/saved/{id} — forget a stored bot.
async fn delete_saved_bot(
    State(s): State<AppState>,
    Path(id): Path<u32>,
) -> StatusCode {
    let mgr = s.manager.lock().unwrap();
    mgr.store.remove(id);
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct SpawnRequest {
    username:       String,
    password:       String,
    mac:            Option<String>,
    proxy_host:     Option<String>,
    proxy_port:     Option<u16>,
    proxy_username: Option<String>,
    proxy_password: Option<String>,
}

/// Normalized frontend-pinned MAC or `None` (caller falls back to random).
/// `Err` → 400 when a MAC was sent but malformed.
fn validated_mac(raw: Option<String>) -> Result<Option<String>, (StatusCode, Json<serde_json::Value>)> {
    match raw {
        None => Ok(None),
        Some(s) if s.trim().is_empty() => Ok(None),
        Some(s) => match crate::protocol::crypto::normalize_mac(&s) {
            Some(m) => Ok(Some(m)),
            None => Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "invalid mac, want XX:XX:XX:XX:XX:XX" })))),
        },
    }
}

async fn spawn_bot(
    State(s): State<AppState>,
    Json(req): Json<SpawnRequest>,
) -> ApiResult<serde_json::Value> {
    let mac = validated_mac(req.mac)?;
    let proxy = match (req.proxy_host, req.proxy_port) {
        (Some(host), Some(port)) => {
            let addr = format!("{}:{}", host, port)
            .parse()
            .or_else(|_| {
                // Try to resolve the host if it's not a valid socket address
                let mut addrs = format!("{}:{}", host, port)
                    .to_socket_addrs()
                    .map_err(|_| StatusCode::BAD_REQUEST)?;
                addrs.next().ok_or(StatusCode::BAD_REQUEST)
            })
            .ok();
            addr.map(|proxy_addr| Socks5Config {
                proxy_addr,
                username: req.proxy_username,
                password: req.proxy_password,
            })
        }
        _ => None,
    };
    let id = s.manager.lock().unwrap().spawn(req.username, req.password, proxy, mac);
    Ok(Json(serde_json::json!({ "id": id })))
}

#[derive(Deserialize)]
struct SpawnLtokenRequest {
    ltoken:         String,
    mac:            Option<String>,
    proxy_host:     Option<String>,
    proxy_port:     Option<u16>,
    proxy_username: Option<String>,
    proxy_password: Option<String>,
}

async fn spawn_ltoken_bot(
    State(s): State<AppState>,
    Json(req): Json<SpawnLtokenRequest>,
) -> ApiResult<serde_json::Value> {
    let mac = validated_mac(req.mac)?;
    // When the sidebar pins a MAC, it must match the bundle's embedded MAC
    // (`token|rid|mac|wk`) — otherwise HTTP login and ENet would diverge.
    if let Some(want) = mac.as_deref() {
        let embedded = req.ltoken.split('|').nth(2).unwrap_or("").to_ascii_uppercase();
        if !embedded.is_empty() && embedded != want {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "mac does not match ltoken bundle" }))));
        }
    }
    let proxy = match (req.proxy_host, req.proxy_port) {
        (Some(host), Some(port)) => {
            let addr = format!("{}:{}", host, port).parse().ok();
            addr.map(|proxy_addr| Socks5Config {
                proxy_addr,
                username: req.proxy_username,
                password: req.proxy_password,
            })
        }
        _ => None,
    };
    let id = s.manager.lock().unwrap().spawn_ltoken(req.ltoken, proxy);
    Ok(Json(serde_json::json!({ "id": id })))
}

async fn stop_bot(
    State(s): State<AppState>,
    Path(id): Path<u32>,
) -> StatusCode {
    let reason = format!("ui (DELETE /bots/{id})");
    if s.manager.lock().unwrap().stop(id, &reason) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn bot_state(
    State(s): State<AppState>,
    Path(id): Path<u32>,
) -> Result<Json<BotState>, StatusCode> {
    s.manager.lock().unwrap()
        .get_state(id)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CmdRequest {
    Move { x: i32, y: i32 },
    WalkTo { x: u32, y: u32 },
    RunScript { content: String },
    StopScript,
    Wear { item_id: u32 },
    Unwear { item_id: u32 },
    Drop { item_id: u32, count: u32 },
    Trash { item_id: u32, count: u32 },
    SetDelays(BotDelays),
    SetAutoCollect { enabled: bool },
    SetCollectConfig {
        radius_tiles: u8,
        #[serde(default)]
        blacklist: Vec<u16>,
    },
    SetAutoReconnect { enabled: bool },
    Disconnect,
    Reconnect,
    SetProxy {
        #[serde(default)]
        proxy_host:     Option<String>,
        #[serde(default)]
        proxy_port:     Option<u16>,
        #[serde(default)]
        proxy_username: Option<String>,
        #[serde(default)]
        proxy_password: Option<String>,
    },
    AcceptAccess,
    Warp { name: String, id: String },
}

#[derive(Deserialize)]
struct ItemsQuery {
    page:      Option<usize>,
    q:         Option<String>,
    #[serde(rename = "get-items")]
    get_items: Option<String>,
}

#[derive(serde::Serialize)]
struct ItemsResponse {
    items:     Vec<ItemInfo>,
    total:     usize,
    page:      usize,
    page_size: usize,
}

const ITEMS_PAGE_SIZE: usize = 50;

async fn list_items(
    State(s): State<AppState>,
    Query(params): Query<ItemsQuery>,
) -> axum::response::Response {
    let mgr = s.manager.lock().unwrap();

    if let Some(ids_str) = params.get_items {
        let ids: std::collections::HashSet<u32> = ids_str
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        let items: Vec<ItemInfo> = mgr.items_dat.items.iter()
            .filter(|i| ids.contains(&i.id))
            .cloned()
            .collect();
        return Json(items).into_response();
    }

    let q = params.q.as_deref().unwrap_or("").to_lowercase();
    let page = params.page.unwrap_or(1).max(1);

    let filtered: Vec<&ItemInfo> = mgr.items_dat.items.iter().filter(|i| {
        if q.is_empty() { return true; }
        if let Ok(id) = q.parse::<u32>() { if i.id == id { return true; } }
        i.name.to_lowercase().contains(&q)
    }).collect();

    let total = filtered.len();
    let start = (page - 1) * ITEMS_PAGE_SIZE;
    let items = filtered.into_iter().skip(start).take(ITEMS_PAGE_SIZE).cloned().collect();

    Json(ItemsResponse { items, total, page, page_size: ITEMS_PAGE_SIZE }).into_response()
}

async fn item_names(State(s): State<AppState>) -> Json<std::collections::HashMap<u32, String>> {
    let mgr = s.manager.lock().unwrap();
    let map = mgr.items_dat.items.iter()
        .map(|i| (i.id, i.name.clone()))
        .collect();
    Json(map)
}

async fn item_colors(State(s): State<AppState>) -> Json<std::collections::HashMap<u32, u32>> {
    let mgr = s.manager.lock().unwrap();
    let map = mgr.items_dat.items.iter()
        .map(|i| {
            let raw = if i.id % 2 == 0 {
                // Block: use seed (id+1) base_color
                mgr.items_dat.find_by_id(i.id + 1)
                    .map(|seed| seed.base_color)
                    .unwrap_or(i.base_color)
            } else {
                // Seed: use own overlay_color
                i.overlay_color
            };
            (i.id, crate::items::bgra_to_rgb(raw))
        })
        .collect();
    Json(map)
}

async fn bot_cmd(
    State(s): State<AppState>,
    Path(id): Path<u32>,
    Json(req): Json<CmdRequest>,
) -> StatusCode {
    let cmd = match req {
        CmdRequest::Move { x, y }   => BotCommand::Move { x, y },
        CmdRequest::WalkTo { x, y } => BotCommand::WalkTo { x, y },
        CmdRequest::RunScript { content }   => BotCommand::RunScript { content },
        CmdRequest::StopScript              => BotCommand::StopScript,
        CmdRequest::Wear { item_id }        => BotCommand::Wear { item_id },
        CmdRequest::Unwear { item_id }      => BotCommand::Unwear { item_id },
        CmdRequest::Drop { item_id, count } => BotCommand::Drop { item_id, count },
        CmdRequest::Trash { item_id, count } => BotCommand::Trash { item_id, count },
        CmdRequest::SetDelays(d) => BotCommand::SetDelays(d),
        CmdRequest::SetAutoCollect { enabled } => BotCommand::SetAutoCollect { enabled },
        CmdRequest::SetCollectConfig {
            radius_tiles,
            blacklist,
        } => BotCommand::SetCollectConfig {
            radius_tiles,
            blacklist,
        },
        CmdRequest::SetAutoReconnect { enabled } => BotCommand::SetAutoReconnect { enabled },
        CmdRequest::Disconnect => BotCommand::Disconnect,
        CmdRequest::Reconnect => BotCommand::Reconnect,
        CmdRequest::SetProxy { proxy_host, proxy_port, proxy_username, proxy_password } => {
            BotCommand::SetProxy {
                proxy: proxy_from_parts(proxy_host, proxy_port, proxy_username, proxy_password),
            }
        }
        CmdRequest::AcceptAccess => BotCommand::AcceptAccess,
        CmdRequest::Warp { name, id } => BotCommand::Warp { name, id },
    };
    let mut mgr = s.manager.lock().unwrap();
    // Remember configuration changes right away (the bot may be offline).
    mgr.record_config_cmd(id, &cmd);
    if mgr.send_cmd(id, cmd) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

// ── Proxy test ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ProxyTestRequest {
    proxy_host:     String,
    proxy_port:     u16,
    proxy_username: Option<String>,
    proxy_password: Option<String>,
}

async fn proxy_check(
    Json(req): Json<ProxyTestRequest>,
) -> Result<Json<ProxyTestResult>, StatusCode> {
    let addr = format!("{}:{}", req.proxy_host, req.proxy_port)
        .parse()
        .or_else(|_| {
            // Try to resolve the host if it's not a valid socket address
            let mut addrs = format!("{}:{}", req.proxy_host, req.proxy_port)
                .to_socket_addrs()
                .map_err(|_| StatusCode::BAD_REQUEST)?;
            addrs.next().ok_or(StatusCode::BAD_REQUEST)
        })?;

    let cfg = Socks5Config {
        proxy_addr: addr,
        username: req.proxy_username,
        password: req.proxy_password,
    };

    let result = tokio::task::spawn_blocking(move || run_proxy_test(cfg))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(result))
}

// ── Google OAuth (browser-assisted login) ───────────────────────────────────

#[derive(Deserialize)]
struct OAuthStartRequest {
    mac:                Option<String>,
    proxy_host:         Option<String>,
    proxy_port:         Option<u16>,
    proxy_username:     Option<String>,
    proxy_password:     Option<String>,
    watch_timeout_secs: Option<u64>,
}

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<serde_json::Value>)>;

fn api_err(msg: impl ToString) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": msg.to_string() })))
}

/// POST /oauth/google/start — mint dashboard state, open authorize URL in
/// CloakBrowser (when configured), start background watch.
async fn oauth_google_start(
    State(s): State<AppState>,
    Json(req): Json<OAuthStartRequest>,
) -> ApiResult<OAuthSessionView> {
    let proxy = proxy_from_parts(req.proxy_host, req.proxy_port, req.proxy_username, req.proxy_password);
    let mac = validated_mac(req.mac)?;
    s.oauth
        .start(proxy, req.watch_timeout_secs.unwrap_or(600).clamp(60, 3600), mac)
        .await
        .map(Json)
        .map_err(api_err)
}

/// GET /oauth/google/:id — poll session status (validated bundle appears here).
async fn oauth_google_status(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<OAuthSessionView>, StatusCode> {
    s.oauth.get(&id).map(Json).ok_or(StatusCode::NOT_FOUND)
}

#[derive(Deserialize)]
struct OAuthCallbackRequest {
    callback_url: String,
}

/// POST /oauth/google/:id/callback — manual path: fetch a pasted
/// `/google/callback?code&state` URL on the session jar, then validate.
async fn oauth_google_callback(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<OAuthCallbackRequest>,
) -> ApiResult<OAuthSessionView> {
    if req.callback_url.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "callback_url required" }))));
    }
    s.oauth.submit_callback_url(&id, req.callback_url).await.map(Json).map_err(|e| {
        if e.contains("unknown oauth session") {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": e })))
        } else {
            api_err(e)
        }
    })
}

#[derive(Deserialize)]
struct OAuthTokenRequest {
    token: String,
}

/// POST /oauth/google/:id/token — manual path: validate a pasted landing token.
async fn oauth_google_token(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<OAuthTokenRequest>,
) -> ApiResult<OAuthSessionView> {
    if req.token.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "token required" }))));
    }
    s.oauth.submit_landing_token(&id, req.token).await.map(Json).map_err(|e| {
        if e.contains("unknown oauth session") {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": e })))
        } else {
            api_err(e)
        }
    })
}

/// POST /oauth/google/:id/refresh — browserless re-login: single checktoken
/// POST with the stored descriptor. Fails → token dead → do a browser run.
async fn oauth_google_refresh(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<OAuthSessionView> {
    s.oauth.refresh(&id).await.map(Json).map_err(|e| {
        if e.contains("unknown oauth session") {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": e })))
        } else {
            api_err(e)
        }
    })
}

#[derive(Deserialize)]
struct OAuthSpawnRequest {
    proxy_host:     Option<String>,
    proxy_port:     Option<u16>,
    proxy_username: Option<String>,
    proxy_password: Option<String>,
}

/// POST /oauth/google/:id/spawn — spawn a bot from the validated bundle.
async fn oauth_google_spawn(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<OAuthSpawnRequest>,
) -> ApiResult<serde_json::Value> {
    let ltoken = s.oauth.ltoken_bundle(&id).ok_or_else(|| {
        if s.oauth.get(&id).is_none() {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "unknown oauth session" })))
        } else {
            (StatusCode::CONFLICT, Json(serde_json::json!({ "error": "session not validated yet" })))
        }
    })?;
    let proxy = proxy_from_parts(req.proxy_host, req.proxy_port, req.proxy_username, req.proxy_password);
    let bot_id = s.manager.lock().unwrap().spawn_ltoken(ltoken, proxy);
    Ok(Json(serde_json::json!({ "id": bot_id, "oauth_id": id })))
}

/// GET /oauth/google/lookup?state=… — session lookup for the browser
/// extension: which Mori session does this OAuth `state` belong to?
///
/// Returns the id plus the `clientData` the extension has to post to
/// `checktoken` from inside the login page.
async fn oauth_google_lookup(
    State(s): State<AppState>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let state = q.get("state").cloned().unwrap_or_default();
    let Some((id, client_data)) = s.oauth.lookup_by_state(&state) else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "no active session for this state" })),
        ));
    };
    Ok(Json(serde_json::json!({
        "id": id,
        "client_data": client_data,
        "checktoken_url": crate::google_oauth::checktoken_url(),
    })))
}

#[derive(Deserialize)]
struct OAuthLandingRequest {
    #[serde(default)]
    token: String,
    #[serde(default)]
    account_type: String,
    #[serde(default)]
    error: String,
}

/// POST /oauth/google/:id/landing — the browser extension reports the result
/// of the in-page `checktoken` POST (same origin, same session cookie).
async fn oauth_google_landing(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<OAuthLandingRequest>,
) -> ApiResult<OAuthSessionView> {
    if req.token.trim().is_empty() {
        let reason = if req.error.trim().is_empty() {
            "extension reported no token".to_string()
        } else {
            format!("extension reported: {}", req.error.trim())
        };
        return Err(api_err(reason));
    }
    s.oauth
        .report_landing(&id, &req.token, &req.account_type)
        .map(Json)
        .map_err(api_err)
}

/// POST /oauth/google/:id/open — open the authorize URL in the user's default
/// browser (started by the OS: no automation flags, so Google accepts it).
async fn oauth_google_open(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<serde_json::Value> {
    s.oauth.open_in_system_browser(&id).map_err(api_err)?;
    Ok(Json(serde_json::json!({ "opened": true })))
}

/// POST /oauth/google/:id/open-bare — open the authorize URL in a **bare**
/// Chrome: no DevTools port, no automation flags, a completely ordinary
/// browser. The sign-in is finished by hand; the result comes back through
/// the helper extension or a pasted token.
async fn oauth_google_open_bare(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<serde_json::Value> {
    let profile = s.oauth.open_in_bare_browser(&id).map_err(api_err)?;
    Ok(Json(serde_json::json!({ "opened": true, "profile": profile })))
}

/// GET /oauth/browser/status — CloakBrowser provider health.
async fn oauth_browser_status() -> Json<crate::remote_view::BrowserStatus> {
    Json(crate::remote_view::browser_status().await)
}

/// GET /oauth/google/:id/view — remote browser viewer socket.
/// Binary down: JPEG frames. Text up: viewer input JSON (`PROTOCOL.md` shapes).
/// Auth via `?token=` (see middleware). No `goto`: tab is server-navigated.
async fn oauth_google_view(
    ws: WebSocketUpgrade,
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let frames = s.oauth.subscribe_frames(&id);
    let Some(frames) = frames else {
        return StatusCode::NOT_FOUND.into_response();
    };
    ws.on_upgrade(move |socket| handle_view_socket(socket, s.oauth, id, frames))
        .into_response()
}

async fn handle_view_socket(
    mut socket: WebSocket,
    oauth: crate::oauth_session::OAuthStore,
    id: String,
    mut frames: tokio::sync::broadcast::Receiver<Vec<u8>>,
) {
    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<crate::remote_view::ViewerMsg>(&text) {
                            Ok(input) => {
                                if !oauth.submit_input(&id, input).await {
                                    break;
                                }
                            }
                            Err(_) => continue,
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => continue,
                }
            }
            frame = frames.recv() => {
                match frame {
                    Ok(bytes) => {
                        if socket.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
    }
}

// ── WebSocket handler ─────────────────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(s): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, s.ws_tx.subscribe()))
}

async fn handle_socket(
    mut socket: WebSocket,
    mut rx: tokio::sync::broadcast::Receiver<crate::events::WsEvent>,
) {
    loop {
        match rx.recv().await {
            Ok(event) => {
                let msg = match serde_json::to_string(&event) {
                    Ok(s)  => s,
                    Err(_) => continue,
                };
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => break,
        }
    }
}

async fn growtopia_cdn(Path(path): Path<String>) -> Response {
    let url = format!("https://growserver-cache.netlify.app/{}", path);
    match tokio::task::spawn_blocking(move || ureq::get(&url).call()).await {
        Ok(Ok(resp)) => {
            let content_type = resp.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_owned();
            let bytes = match resp.into_body().read_to_vec() {
                Ok(b) => b,
                Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
            };
            Response::builder()
                .header("content-type", content_type)
                .body(Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Ok(Err(_)) | Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn index_html() -> impl IntoResponse {
    let dist = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("dist");

    let html = tokio::fs::read_to_string(dist.join("index.html"))
        .await
        .unwrap_or_default();

    let injected = html.replace(
        "</body>",
        r#"<div style="position:fixed;bottom:8px;right:12px;font-size:10px;opacity:0.35;color:#fff;pointer-events:none;z-index:9999;font-family:sans-serif;">Mori created with &#x2764;&#xfe0e; by Cendy</div></body>"#,
    );

    axum::response::Html(injected)
}

pub async fn serve(manager: SharedManager, ws_tx: WsTx) {
    let auth = AuthState::new();
    let state = AppState { manager, ws_tx, auth, oauth: OAuthStore::new() };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::PATCH])
        .allow_headers(Any);

    let dist = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("dist");

    let app = Router::new()
        .route("/", get(index_html))

        // Auth endpoints (public)
        .route("/auth/status", get(auth_status))
        .route("/auth/setup",  post(auth_setup))
        .route("/auth/login",  post(auth_login))
        .route("/auth/logout", post(auth_logout))

        // Protected API
        .route("/bots", get(list_bots).post(spawn_bot))
        .route("/bots/ltoken", post(spawn_ltoken_bot))
        .route("/bots/{id}", delete(stop_bot))
        .route("/bots/{id}/state", get(bot_state))
        .route("/bots/{id}/cmd", post(bot_cmd))
        .route("/bots/saved", get(list_saved_bots))
        .route("/bots/saved/{id}/spawn", post(spawn_saved_bot))
        .route("/bots/saved/{id}/restart", post(restart_saved_bot))
        .route("/bots/saved/{id}", patch(patch_saved_bot).delete(delete_saved_bot))
        .route("/items", get(list_items))
        .route("/items/names", get(item_names))
        .route("/items/colors", get(item_colors))
        .route("/proxy/test", post(proxy_check))
        .route("/oauth/google/start", post(oauth_google_start))
        .route("/oauth/google/{id}", get(oauth_google_status))
        .route("/oauth/google/{id}/callback", post(oauth_google_callback))
        .route("/oauth/google/{id}/token", post(oauth_google_token))
        .route("/oauth/google/{id}/refresh", post(oauth_google_refresh))
        .route("/oauth/google/{id}/spawn", post(oauth_google_spawn))
        .route("/oauth/google/{id}/open", post(oauth_google_open))
        .route("/oauth/google/{id}/open-bare", post(oauth_google_open_bare))
        .route("/oauth/google/{id}/landing", post(oauth_google_landing))
        .route("/oauth/google/lookup", get(oauth_google_lookup))
        .route("/oauth/google/{id}/view", get(oauth_google_view))
        .route("/oauth/browser/status", get(oauth_browser_status))
        .route("/growtopia-cdn/{*path}", get(growtopia_cdn))
        .route("/ws", get(ws_handler))

        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .layer(cors)
        .with_state(state)
        .fallback_service(ServeDir::new(&dist).fallback(ServeFile::new(dist.join("index.html"))));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3005").await.unwrap();
    println!("Dashboard  http://localhost:3005");
    println!("WebSocket  ws://localhost:3005/ws");
    println!("API        http://localhost:3005/bots");
    // LAN address, so a phone on the same network can open the dashboard.
    for ip in lan_addresses() {
        println!("LAN        http://{ip}:3005");
    }
    axum::serve(listener, app).await.unwrap();
}
