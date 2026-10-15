//! Google OAuth headless leg (no browser).
//!
//! Ports `sandbox/demo_google_login.py` (verified live 2026-10-14, see
//! `sandbox/reports/06-google-login-replication.md`):
//!
//! 1. `server_data.php` with the real client UA → `meta`
//! 2. dashboard POST with a WebView2 Chrome UA + custom percent-encoding → google `/redirect` href
//! 3. `GET google/redirect` (same cookie jar) → 302 `accounts.google.com/o/oauth2/auth` (+ params)
//! 4. (browser step happens elsewhere — [`crate::browser`])
//! 5. `GET /google/callback?code&state` with the SAME agent → landing JSON `{"status":"success","token"}`
//! 6. form-encoded `checktoken` on the SAME agent → `Account Validated` (token echoed back)
//!
//! Rules mirrored from the reports:
//! - fresh `meta` + fresh `rid` per attempt; backoff 10/30/60 s on the throttle envelope
//! - strict JSON accept for the landing token; loose regex only as fallback on `/google/callback`
//! - all OAuth params are server-served; nothing is hardcoded except the
//!   in-game `(game_version, protocol)` pair from `crate::constants`.

use std::time::Duration;

use rand::Rng;
use regex::Regex;
use ureq::ResponseExt;

use crate::protocol::crypto::{compute_klv, generate_rid, hash_string, random_hex, random_mac};
use crate::server_data::ServerData;

/// OAuth descriptor uses Mori's in-game pair (`constants.rs`: 5.59/225).
pub const OAUTH_GAME_VERSION: &str = crate::constants::GAME_VER;
pub const OAUTH_PROTOCOL_U32: u32 = crate::constants::PROTOCOL;
const OAUTH_FHASH: i32 = -716928004;

const SERVER_DATA_URL: &str = "https://www.growtopia1.com/growtopia/server_data.php";
const DASHBOARD_URL: &str = "https://login.growtopiagame.com/player/login/dashboard?valKey=40db4045f2d8c572efe8c4a060605726";
const CHECKTOKEN_URL: &str = "https://login.growtopiagame.com/player/growid/checktoken?valKey=40db4045f2d8c572efe8c4a060605726";

pub const CLIENT_UA: &str = "UbiServices_SDK_2022.Release.9_PC64_ansi_static";
pub const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const SEC_CH_UA: &str = "\"Chromium\";v=\"128\", \"Not;A=Brand\";v=\"24\", \"Microsoft Edge\";v=\"128\", \"Microsoft Edge WebView2\";v=\"128\"";

const COUNTRIES: &[&str] = &[
    "us", "gb", "de", "fr", "tr", "br", "id", "ph", "in", "mx", "ca", "au", "nl", "se", "no", "fi",
    "dk", "pl", "es", "it", "pt", "gr", "ro", "ua", "ru", "eg", "sa", "ae", "za", "ng", "my",
    "sg", "th", "vn", "kr", "jp", "cn", "tw", "hk", "ar", "cl", "co", "pe", "nz", "ie", "be",
    "ch", "at",
];

#[derive(Debug)]
pub enum OAuthError {
    /// Dashboard throttle / stale-state envelope — caller should back off and retry fresh.
    Retryable(String),
    Fatal(String),
}

impl std::fmt::Display for OAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OAuthError::Retryable(m) => write!(f, "retryable: {m}"),
            OAuthError::Fatal(m) => write!(f, "{m}"),
        }
    }
}
impl std::error::Error for OAuthError {}

pub type OAuthResult<T> = std::result::Result<T, OAuthError>;

fn err_fatal(e: impl ToString) -> OAuthError {
    OAuthError::Fatal(e.to_string())
}

/// Game client percent-encoding: ASCII alnum passes through, space is deleted,
/// `\n` → `%0A`, everything else → `%XX` uppercase.
pub fn client_percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() {
            out.push(b as char);
        } else if b == b' ' {
            continue;
        } else if b == b'\n' {
            out.push_str("%0A");
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Fresh per-attempt OAuth descriptor (raw pipe body) + its random parts.
/// `hash` is deterministic (`hash_string("RT")`); everything else is fresh.
pub struct OAuthDescriptor {
    pub raw: String,
    pub rid: String,
    pub mac: String,
    pub wk: String,
    /// Deterministic `hash_string("RT")` used in the `klv` chain (kept for
    /// bundle reconstruction; the raw body carries the wire value).
    #[allow(dead_code)]
    pub hash: i32,
}

pub fn build_descriptor(meta: &str) -> OAuthDescriptor {
    let mut rng = rand::rng();
    let rid = generate_rid();
    let hash = hash_string("RT");
    let protocol = OAUTH_PROTOCOL_U32.to_string();
    let klv = compute_klv(OAUTH_GAME_VERSION, &protocol, &rid, hash);
    let requested: u32 = rng.random_range(10000..100000);
    let hash2: u32 = rng.random_range(100_000_000..1_000_000_000);
    let country = COUNTRIES[rng.random_range(0..COUNTRIES.len())];
    let mac = random_mac();
    let wk = random_hex(32);
    let raw = format!(
        "tankIDName|\ntankIDPass|\nrequestedName|{requested}\n\
         f|1\nprotocol|{protocol}\ngame_version|{v}\n\
         fz|22745624\nlmode|0\ncbits|1024\nplayer_age|22\nGDPR|2\n\
         category|_-5000\ntotalPlaytime|0\nklv|{klv}\n\
         hash2|-{hash2}\nmeta|{meta}\n\
         fhash|{OAUTH_FHASH}\nrid|{rid}\n\
         platformID|0,1,1\ndeviceVersion|0\ncountry|{country}\n\
         hash|{hash}\nmac|{mac}\nwk|{wk}\nzf|283949556",
        v = OAUTH_GAME_VERSION,
    );
    OAuthDescriptor {
        raw,
        rid,
        mac,
        wk,
        hash,
    }
}

/// One shared blocking HTTP agent = the game's single WebView2 cookie store.
/// Must be reused for dashboard → redirect → callback → checktoken.
pub fn new_oauth_agent(proxy_url: Option<&str>) -> OAuthResult<ureq::Agent> {
    let mut builder = ureq::config::Config::builder().timeout_global(Some(Duration::from_secs(20)));
    if let Some(p) = proxy_url {
        let proxy = ureq::Proxy::new(p).map_err(err_fatal)?;
        builder = builder.proxy(Some(proxy));
    }
    Ok(ureq::Agent::new_with_config(builder.build()))
}

/// Step 1: `server_data.php` → `meta` (same in-game pair as the descriptor).
pub fn step_server_data(agent: &ureq::Agent) -> OAuthResult<String> {
    let body = format!(
        "version={}&platform=0&protocol={}",
        OAUTH_GAME_VERSION, OAUTH_PROTOCOL_U32
    );
    let body = agent
        .post(SERVER_DATA_URL)
        .header("User-Agent", CLIENT_UA)
        .header("Accept", "*/*")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send(body)
        .map_err(err_fatal)?
        .body_mut()
        .read_to_string()
        .map_err(err_fatal)?;
    let data = ServerData::parse_from_response(&body).map_err(err_fatal)?;
    if data.meta.is_empty() {
        return Err(err_fatal("no meta| in server_data.php response"));
    }
    Ok(data.meta)
}

/// Step 2: dashboard POST → `(descriptor, google_redirect_href)`.
/// The throttle envelope (`{"status":"failed",...}` or a page without the
/// google link) is `Retryable`: caller must mint fresh meta+rid and back off.
pub fn step_dashboard(
    agent: &ureq::Agent,
    meta: &str,
) -> OAuthResult<(OAuthDescriptor, String)> {
    let desc = build_descriptor(meta);
    let encoded = client_percent_encode(&desc.raw);
    let html = agent
        .post(DASHBOARD_URL)
        .header("User-Agent", BROWSER_UA)
        .header("sec-ch-ua", SEC_CH_UA)
        .header("sec-ch-ua-mobile", "?0")
        .header("sec-ch-ua-platform", "\"Windows\"")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Origin", "null")
        .header("Referer", DASHBOARD_URL)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        )
        .send(encoded)
        .map_err(err_fatal)?
        .body_mut()
        .read_to_string()
        .map_err(err_fatal)?;

    if html.trim_start().starts_with('{') {
        let msg = serde_json::from_str::<serde_json::Value>(&html)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| "dashboard throttle envelope".to_string());
        return Err(OAuthError::Retryable(format!("dashboard rejected: {msg}")));
    }

    let re = Regex::new(r#"href="(https://login\.growtopiagame\.com/google/redirect\?token=[^"]+)""#)
        .map_err(err_fatal)?;
    let href = re
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().replace("&amp;", "&"))
        .ok_or_else(|| {
            OAuthError::Retryable("no google redirect link in dashboard HTML".to_string())
        })?;
    Ok((desc, href))
}

#[derive(Debug, Clone)]
pub struct AuthorizeParams {
    pub url: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scope: String,
    pub response_type: String,
    pub state: String,
}

/// Step 3: `GET google_href` (same jar) → Google authorize URL + params.
/// ureq follows the 302; the authorize URL is recovered from redirect history.
pub fn step_google_redirect(
    agent: &ureq::Agent,
    google_href: &str,
) -> OAuthResult<AuthorizeParams> {
    let resp = agent
        .get(google_href)
        .config()
        .save_redirect_history(true)
        .build()
        .header("User-Agent", BROWSER_UA)
        .header("Referer", DASHBOARD_URL)
        .call()
        .map_err(err_fatal)?;
    let history = resp.get_redirect_history().unwrap_or(&[]);
    let auth_url = history
        .iter()
        .map(ToString::to_string)
        .find(|u| u.contains("accounts.google.com"))
        .or_else(|| {
            let u = resp.get_uri().to_string();
            u.contains("accounts.google.com").then_some(u)
        })
        .ok_or_else(|| err_fatal("google/redirect did not lead to accounts.google.com"))?;
    parse_authorize_url(&auth_url)
}

/// Parse + validate an OAuth authorize URL (shared by live redirect + tests).
pub fn parse_authorize_url(auth_url: &str) -> OAuthResult<AuthorizeParams> {
    let parsed = auth_url.parse::<ureq::http::Uri>().map_err(err_fatal)?;
    if parsed.host() != Some("accounts.google.com") || parsed.path() != "/o/oauth2/auth" {
        return Err(err_fatal("unexpected authorize target (want accounts.google.com/o/oauth2/auth)"));
    }
    let q: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(parsed.query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    for key in ["client_id", "redirect_uri", "scope", "response_type", "state"] {
        if q.get(key).is_none_or(|v| v.is_empty()) {
            return Err(err_fatal(format!("authorize URL missing {key}")));
        }
    }
    Ok(AuthorizeParams {
        url: auth_url.to_string(),
        client_id: q["client_id"].clone(),
        redirect_uri: q["redirect_uri"].clone(),
        scope: q["scope"].clone(),
        response_type: q["response_type"].clone(),
        state: q["state"].clone(),
    })
}

/// Strict landing-token accept: body must parse as JSON
/// `{"status":"success","token":"…"}` with a non-empty token.
/// Rejects lookalike HTML (e.g. `/logon-name` pages whose JS mentions
/// `"status"`/`"token"` strings) — report 07 §4.
pub fn extract_token_strict(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    if v.get("status")?.as_str()? != "success" {
        return None;
    }
    let token = v.get("token")?.as_str()?;
    (!token.is_empty()).then(|| token.to_string())
}

/// Loose fallback — trusted ONLY on the real `/google/callback` path.
pub fn extract_token_loose(body: &str, url: &str) -> Option<String> {
    if !url.contains("/google/callback") {
        return None;
    }
    let status_re = Regex::new(r#""status"\s*:\s*"success""#).ok()?;
    let token_re = Regex::new(r#""token"\s*:\s*"([^"]+)""#).ok()?;
    if status_re.is_match(body) {
        token_re
            .captures(body)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
    } else {
        None
    }
}

/// Step 5: fetch the Google callback URL with the SAME agent (single jar).
pub fn step_callback(
    agent: &ureq::Agent,
    callback_url: &str,
    authorize_url: &str,
) -> OAuthResult<String> {
    let mut resp = agent
        .get(callback_url)
        .header("User-Agent", BROWSER_UA)
        .header("Referer", authorize_url)
        .call()
        .map_err(err_fatal)?;
    let final_url = resp.get_uri().to_string();
    let body = resp.body_mut().read_to_string().map_err(err_fatal)?;
    extract_token_strict(&body)
        .or_else(|| extract_token_loose(&body, &final_url))
        .or_else(|| extract_token_loose(&body, callback_url))
        .ok_or_else(|| err_fatal("callback did not render a success token landing page"))
}

#[derive(Debug, Clone)]
pub struct ValidatedBundle {
    pub token: String,
    pub account_type: String,
    pub rid: String,
    pub mac: String,
    pub wk: String,
}

impl ValidatedBundle {
    /// `token|rid|mac|wk` — the shape `Bot::new_ltoken` parses.
    pub fn ltoken_string(&self) -> String {
        format!("{}|{}|{}|{}", self.token, self.rid, self.mac, self.wk)
    }
}

/// Step 6: form-encoded `checktoken` on the SAME agent (single jar — a fresh
/// agent here reproduces the 07 §3 cookie-split failure). Routes by
/// content-type to `/player/growid/validate/checktoken/<token>` and succeeds;
/// JSON-body variants 307 elsewhere and fail, so only the form shape is sent.
pub fn step_checktoken(
    agent: &ureq::Agent,
    landing_token: &str,
    desc: &OAuthDescriptor,
) -> OAuthResult<ValidatedBundle> {
    if landing_token.is_empty() {
        return Err(err_fatal("landing token is empty"));
    }
    let body = agent
        .post(CHECKTOKEN_URL)
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Origin", "null")
        .header("Referer", DASHBOARD_URL)
        .send_form([
            ("refreshToken", landing_token),
            ("clientData", desc.raw.as_str()),
        ])
        .map_err(err_fatal)?
        .body_mut()
        .read_to_string()
        .map_err(err_fatal)?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(err_fatal)?;
    if v.get("status").and_then(|s| s.as_str()) == Some("success") {
        Ok(ValidatedBundle {
            token: v
                .get("token")
                .and_then(|t| t.as_str())
                .filter(|t| !t.is_empty())
                .unwrap_or(landing_token)
                .to_string(),
            account_type: v
                .get("accountType")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string(),
            rid: desc.rid.clone(),
            mac: desc.mac.clone(),
            wk: desc.wk.clone(),
        })
    } else {
        Err(err_fatal(format!("token validation failed: {v}")))
    }
}

/// Snapshot of the agent's `login.growtopiagame.com` cookies for seeding into
/// the browser profile (report 07 §3: dashboard cookies → browser before authorize).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SeedCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
}

pub fn export_seed_cookies(agent: &ureq::Agent) -> Vec<SeedCookie> {
    agent
        .cookie_jar_lock()
        .iter()
        .map(|c| SeedCookie {
            name: c.name().to_string(),
            value: c.value().to_string(),
            domain: "login.growtopiagame.com".to_string(),
            path: "/".to_string(),
        })
        .collect()
}

/// Full mint with throttle backoff: fresh `meta` + fresh `rid` per attempt,
/// sleeps 10/30/60 s between attempts (blocking — call inside `spawn_blocking`).
pub struct MintedSession {
    pub agent: ureq::Agent,
    pub meta: String,
    pub desc: OAuthDescriptor,
    pub google_href: String,
    pub authorize: AuthorizeParams,
    pub seed_cookies: Vec<SeedCookie>,
}

pub fn mint_with_backoff(proxy_url: Option<&str>, max_attempts: usize) -> OAuthResult<MintedSession> {
    let backoff = [10, 30, 60];
    let mut last_err = OAuthError::Fatal("no attempts made".to_string());
    for attempt in 0..max_attempts.max(1) {
        let agent = new_oauth_agent(proxy_url)?;
        let outcome = (|| -> OAuthResult<MintedSession> {
            let meta = step_server_data(&agent)?;
            // Demo spacing (~1.5 s) between mint calls — be kind to the throttle.
            std::thread::sleep(Duration::from_millis(1500));
            let (desc, google_href) = step_dashboard(&agent, &meta)?;
            std::thread::sleep(Duration::from_millis(1500));
            let authorize = step_google_redirect(&agent, &google_href)?;
            let seed_cookies = export_seed_cookies(&agent);
            Ok(MintedSession {
                agent,
                meta,
                desc,
                google_href,
                authorize,
                seed_cookies,
            })
        })();
        match outcome {
            Ok(m) => return Ok(m),
            Err(OAuthError::Retryable(msg)) => {
                last_err = OAuthError::Retryable(msg);
                if attempt + 1 < max_attempts.max(1) {
                    let wait = backoff.get(attempt).copied().unwrap_or(60);
                    std::thread::sleep(Duration::from_secs(wait));
                }
            }
            Err(fatal) => return Err(fatal),
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_matches_game_table() {
        assert_eq!(client_percent_encode("abcXYZ019"), "abcXYZ019");
        assert_eq!(client_percent_encode("a b"), "ab"); // space deleted
        assert_eq!(client_percent_encode("a|b\nc"), "a%7Cb%0Ac");
        assert_eq!(client_percent_encode("_-"), "%5F%2D");
    }

    #[test]
    fn descriptor_has_required_fields() {
        let d = build_descriptor("testmeta");
        for field in ["klv|", "rid|", "wk|", "mac|", "meta|testmeta", "hash|-1431569110"] {
            assert!(d.raw.contains(field), "missing {field}");
        }
        assert!(d.raw.contains("protocol|225\n"), "want mori protocol 225");
        assert!(d.raw.contains("game_version|5.59\n"), "want mori game version");
        assert_eq!(d.rid.len(), 32);
        assert_eq!(d.wk.len(), 32);
        assert_eq!(d.hash, -1431569110);
    }

    #[test]
    fn strict_accepts_only_real_json() {
        let good = r#"{"status":"success","token":"EpWoABC","url":"","accountType":"google"}"#;
        assert_eq!(extract_token_strict(good).as_deref(), Some("EpWoABC"));
        // Lookalike HTML (logon-name page JS) must be rejected.
        let html = r#"<html><script>var s="status";var t="token";</script><body>pick a name</body></html>"#;
        assert_eq!(extract_token_strict(html), None);
        assert_eq!(extract_token_strict(r#"{"status":"failed","token":"x"}"#), None);
        assert_eq!(extract_token_strict(r#"{"status":"success","token":""}"#), None);
    }

    #[test]
    fn loose_fallback_is_callback_path_only() {
        let body = r#"{"status": "success", "token": "EpWoABC"}"#;
        assert_eq!(
            extract_token_loose(body, "https://login.growtopiagame.com/google/callback?code=1").as_deref(),
            Some("EpWoABC")
        );
        assert_eq!(
            extract_token_loose(body, "https://login.growtopiagame.com/player/growid/logon-name/blob"),
            None
        );
    }

    #[test]
    fn authorize_url_parses() {
        let url = "https://accounts.google.com/o/oauth2/auth?client_id=389994132396-abc.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Flogin.growtopiagame.com%2Fgoogle%2Fcallback&scope=openid+profile+email&response_type=code&state=xyz&prompt=select_account";
        let p = parse_authorize_url(url).unwrap();
        assert!(p.client_id.starts_with("389994132396-"));
        assert_eq!(p.redirect_uri, "https://login.growtopiagame.com/google/callback");
        assert_eq!(p.response_type, "code");
    }

    #[test]
    fn authorize_url_rejects_embedded_host() {
        assert!(parse_authorize_url("https://login.growtopiagame.com/google/callback?code=1").is_err());
    }
}
