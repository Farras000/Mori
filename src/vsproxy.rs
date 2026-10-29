use std::net::{SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use crate::bot::Socks5Config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VsProxyConfig {
    pub api_key: String,
    pub subuser_id: Option<String>,
    pub invoice: Option<String>,
    pub country: String,
    pub mode: String,
    pub base_rotation: u32,
    pub anon: bool,
    pub max_retries: u32,
    pub auto_roll: bool,
    pub cooldown_secs: u64,
}

impl Default for VsProxyConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            subuser_id: None,
            invoice: None,
            country: "us".into(),
            mode: "sticky".into(),
            base_rotation: 50,
            anon: true,
            max_retries: 3,
            auto_roll: true,
            cooldown_secs: 65,
        }
    }
}

impl VsProxyConfig {
    pub fn from_env() -> Option<Self> {
        // Look for API key first
        let api_key = std::env::var("VSPROXY_API_KEY").ok().unwrap_or_default();
        let api_key = api_key.trim().to_string();

        let subuser_id = std::env::var("VSPROXY_SUBUSER_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let invoice = std::env::var("VSPROXY_INVOICE")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let country = std::env::var("VSPROXY_COUNTRY")
            .unwrap_or_else(|_| "us".into())
            .trim()
            .to_string();

        let mode = std::env::var("VSPROXY_MODE")
            .unwrap_or_else(|_| "sticky".into())
            .trim()
            .to_string();

        let base_rotation = std::env::var("VSPROXY_ROTATION")
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(50)
            .clamp(1, 120);

        let anon = std::env::var("VSPROXY_ANON")
            .ok()
            .map(|s| s.trim().to_lowercase() == "true" || s.trim() == "1")
            .unwrap_or(true);

        let max_retries = std::env::var("VSPROXY_MAX_RETRIES")
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(3);

        let auto_roll = match (
            std::env::var("AUTO_ROTATE_RECONNECT"),
            std::env::var("VSPROXY_AUTO_ROLL"),
        ) {
            (Ok(v1), Ok(v2)) => {
                let b1 = v1.trim().to_lowercase() == "true" || v1.trim() == "1";
                let b2 = v2.trim().to_lowercase() == "true" || v2.trim() == "1";
                b1 && b2
            }
            (Ok(v), Err(_)) | (Err(_), Ok(v)) => {
                v.trim().to_lowercase() == "true" || v.trim() == "1"
            }
            (Err(_), Err(_)) => true,
        };

        let cooldown_secs = std::env::var("VSPROXY_COOLDOWN_SECS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(65);

        Some(Self {
            api_key,
            subuser_id,
            invoice,
            country,
            mode,
            base_rotation,
            anon,
            max_retries,
            auto_roll,
            cooldown_secs,
        })
    }
}

#[derive(Debug)]
pub enum VsProxyError {
    Cooldown { remaining_secs: u64 },
    MissingCredentials(String),
    Network(String),
    ApiError(String),
    ParseError(String),
}

impl std::fmt::Display for VsProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VsProxyError::Cooldown { remaining_secs } => {
                write!(f, "Cooldown active: please wait {remaining_secs}s before rerolling proxy")
            }
            VsProxyError::MissingCredentials(msg) => write!(f, "Missing credentials: {msg}"),
            VsProxyError::Network(msg) => write!(f, "Network error: {msg}"),
            VsProxyError::ApiError(msg) => write!(f, "API error: {msg}"),
            VsProxyError::ParseError(msg) => write!(f, "Parse error: {msg}"),
        }
    }
}

impl std::error::Error for VsProxyError {}

pub const ROTATION_MIN: u32 = 50;
pub const ROTATION_MAX: u32 = 60;

/// Calculates the next rotation minutes to force VSProxy to generate a fresh IP.
/// Strictly cycles between: 50 -> 51 -> 52 -> ... -> 60 -> 50 -> ...
pub fn calculate_next_rotation(base_rotation: u32, current_proxy: Option<&Socks5Config>) -> u32 {
    let current_val = current_proxy
        .and_then(|p| p.username.as_deref())
        .and_then(extract_sessttl_from_username);

    let min_rot = if base_rotation >= ROTATION_MIN && base_rotation <= ROTATION_MAX {
        base_rotation
    } else {
        ROTATION_MIN
    };
    let max_rot = ROTATION_MAX;

    match current_val {
        Some(val) if val >= min_rot && val < max_rot => val + 1,
        Some(val) if val >= max_rot => min_rot,
        _ => min_rot,
    }
}

/// Queries external IP through the given SOCKS5 proxy using ipify.org, icanhazip.com, or ifconfig.me.
pub fn check_proxy_ip(proxy: &Socks5Config) -> Result<String, String> {
    let proxy_url = proxy.to_url();
    let proxy_target = ureq::Proxy::new(&proxy_url)
        .map_err(|e| format!("Invalid proxy URL '{proxy_url}': {e}"))?;

    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .proxy(Some(proxy_target))
            .timeout_global(Some(Duration::from_secs(10)))
            .build(),
    );

    let endpoints = [
        "https://api.ipify.org",
        "https://icanhazip.com",
        "https://ifconfig.me/ip",
    ];

    let mut last_err = String::new();
    for endpoint in endpoints {
        match agent
            .get(endpoint)
            .header("User-Agent", "curl/7.88.1")
            .call()
        {
            Ok(mut resp) => {
                if let Ok(body) = resp.body_mut().read_to_string() {
                    let ip = body.trim().to_string();
                    if ip.parse::<std::net::IpAddr>().is_ok() {
                        return Ok(ip);
                    }
                }
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
    }

    Err(format!("All IP check endpoints failed (last: {last_err})"))
}

/// Extracts the `sessttl.X` value from a VSProxy username string.
pub fn extract_sessttl_from_username(uname: &str) -> Option<u32> {
    for part in uname.split(&[';', ':'][..]) {
        let part = part.trim();
        if let Some(ttl_str) = part.strip_prefix("sessttl.") {
            let digits: String = ttl_str.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(v) = digits.parse::<u32>() {
                return Some(v);
            }
        }
    }
    None
}

/// Resolves subuser_id either from config or extracted from the current proxy username
/// (e.g. `acd0495816223c2984b0__cr.us...` -> `acd0495816223c2984b0`).
pub fn resolve_subuser_id(cfg: &VsProxyConfig, current_proxy: Option<&Socks5Config>) -> Option<String> {
    if let Some(ref sub) = cfg.subuser_id {
        if !sub.is_empty() {
            return Some(sub.clone());
        }
    }

    if let Some(p) = current_proxy {
        if let Some(uname) = &p.username {
            if let Some((sub, _)) = uname.split_once("__") {
                if !sub.is_empty() {
                    return Some(sub.to_string());
                }
            }
        }
    }

    None
}

/// Parses a single line from the VSProxy `list` response.
/// Format: `host:port:username:password`
pub fn parse_proxy_line(line: &str) -> Option<(String, u16, String, String)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    // Line format: host:port:username:password
    let mut parts = line.splitn(4, ':');
    let host = parts.next()?.to_string();
    let port = parts.next()?.parse::<u16>().ok()?;
    let username = parts.next()?.to_string();
    let password = parts.next()?.to_string();

    Some((host, port, username, password))
}

/// Converts host + port + credentials into a resolved `Socks5Config`.
pub fn build_socks5_config(
    host: &str,
    port: u16,
    username: Option<String>,
    password: Option<String>,
) -> Result<Socks5Config, VsProxyError> {
    let addr_str = format!("{host}:{port}");
    let addr: SocketAddr = addr_str
        .parse()
        .ok()
        .or_else(|| addr_str.to_socket_addrs().ok().and_then(|mut a| a.next()))
        .ok_or_else(|| VsProxyError::ParseError(format!("Failed to resolve proxy address: {addr_str}")))?;

    Ok(Socks5Config {
        proxy_addr: addr,
        username,
        password,
    })
}

/// Directly mutates the `sessttl` tag in an existing VSProxy username.
/// Used as a fallback or instant bumper.
pub fn bump_vsproxy_session(current: &Socks5Config, base_rotation: u32) -> Option<Socks5Config> {
    let uname = current.username.as_ref()?;
    let next_ttl = calculate_next_rotation(base_rotation, Some(current));

    let mut new_parts = Vec::new();
    let mut found_ttl = false;
    let mut has_anon = false;

    for part in uname.split(';') {
        let trimmed = part.trim();
        if trimmed.starts_with("sessttl.") {
            if let Some((_, rest)) = trimmed.split_once(':') {
                new_parts.push(format!("sessttl.{next_ttl}:{rest}"));
            } else {
                new_parts.push(format!("sessttl.{next_ttl}"));
            }
            found_ttl = true;
        } else {
            if trimmed.starts_with("anon.") {
                has_anon = true;
            }
            new_parts.push(trimmed.to_string());
        }
    }

    if !found_ttl {
        new_parts.push(format!("sessttl.{next_ttl}"));
    }
    if !has_anon {
        new_parts.push("anon.1".to_string());
    }

    let new_username = new_parts.join(";");

    Some(Socks5Config {
        proxy_addr: current.proxy_addr,
        username: Some(new_username),
        password: current.password.clone(),
    })
}

/// Core function to perform proxy rolling.
/// Enforces cooldown (default 65s), contacts the VSProxy API, and returns new `Socks5Config`.
pub fn roll_proxy(
    cfg: &VsProxyConfig,
    current_proxy: Option<&Socks5Config>,
    last_roll: Option<Instant>,
) -> Result<Socks5Config, VsProxyError> {
    // 1. Enforce cooldown guard
    if let Some(last) = last_roll {
        let elapsed = last.elapsed();
        let cooldown = Duration::from_secs(cfg.cooldown_secs);
        if elapsed < cooldown {
            let remaining = (cooldown - elapsed).as_secs() + 1;
            return Err(VsProxyError::Cooldown {
                remaining_secs: remaining,
            });
        }
    }

    let next_rotation = calculate_next_rotation(cfg.base_rotation, current_proxy);
    let subuser_opt = resolve_subuser_id(cfg, current_proxy);

    // If API key is available, call the API
    if !cfg.api_key.is_empty() {
        let mut payload_map = serde_json::Map::new();

        if let Some(ref inv) = cfg.invoice {
            payload_map.insert("invoice".into(), json!(inv));
        } else if let Some(sub) = subuser_opt {
            payload_map.insert("subuser_id".into(), json!(sub));
        } else {
            return Err(VsProxyError::MissingCredentials(
                "Neither VSPROXY_INVOICE nor VSPROXY_SUBUSER_ID could be determined".into(),
            ));
        }

        payload_map.insert("ports".into(), json!(1));
        payload_map.insert("country".into(), json!(cfg.country));
        payload_map.insert("mode".into(), json!(cfg.mode));
        payload_map.insert("rotation".into(), json!(next_rotation));
        payload_map.insert("anon".into(), json!(cfg.anon));

        let payload_str = Value::Object(payload_map).to_string();

        let agent = ureq::Agent::new_with_config(
            ureq::config::Config::builder()
                .timeout_global(Some(Duration::from_secs(20)))
                .http_status_as_error(false)
                .build(),
        );

        let req = ureq::http::Request::builder()
            .method("POST")
            .uri("https://vsproxy.org/api/v3/genport")
            .header("X-API-Key", &cfg.api_key)
            .header("Content-Type", "application/json")
            .body(payload_str)
            .map_err(|e| VsProxyError::Network(e.to_string()))?;

        let mut resp = agent.run(req).map_err(|e| VsProxyError::Network(e.to_string()))?;
        let status = resp.status();
        let body_str = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| VsProxyError::Network(e.to_string()))?;

        if status == 200 {
            if let Ok(val) = serde_json::from_str::<Value>(&body_str) {
                if val["ok"].as_bool() == Some(true) {
                    if let Some(list_str) = val["list"].as_str() {
                        if let Some(first_line) = list_str.lines().next() {
                            if let Some((host, port, u, p)) = parse_proxy_line(first_line) {
                                return build_socks5_config(&host, port, Some(u), Some(p));
                            }
                        }
                    }
                }
                return Err(VsProxyError::ApiError(format!(
                    "API response returned ok=false or missing list: {body_str}"
                )));
            }
        }

        // If API returned error (e.g. 429), try fallback bumper if current proxy exists
        if let Some(curr) = current_proxy {
            if let Some(bumped) = bump_vsproxy_session(curr, cfg.base_rotation) {
                return Ok(bumped);
            }
        }

        return Err(VsProxyError::ApiError(format!(
            "HTTP {status} from vsproxy genport: {body_str}"
        )));
    }

    // If API key is not yet set, fallback to tag bumper if current proxy format is valid
    if let Some(curr) = current_proxy {
        if let Some(bumped) = bump_vsproxy_session(curr, cfg.base_rotation) {
            return Ok(bumped);
        }
    }

    Err(VsProxyError::MissingCredentials(
        "VSPROXY_API_KEY is not set in .env".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_proxy_line() {
        let line = "gb.vsproxy.org:10000:a1b2c3d4__cr.us;sessttl.45;anon.1:p4ssw0rd";
        let parsed = parse_proxy_line(line).expect("Should parse");
        assert_eq!(parsed.0, "gb.vsproxy.org");
        assert_eq!(parsed.1, 10000);
        assert_eq!(parsed.2, "a1b2c3d4__cr.us;sessttl.45;anon.1");
        assert_eq!(parsed.3, "p4ssw0rd");
    }

    #[test]
    fn test_extract_and_rotate() {
        let uname = "acd0495816223c2984b0__cr.us;sessttl.45:b4c2f01cc617cda0";
        assert_eq!(extract_sessttl_from_username(uname), Some(45));

        let mock_cfg_45 = Socks5Config {
            proxy_addr: "127.0.0.1:10000".parse().unwrap(),
            username: Some(uname.to_string()),
            password: Some("pass".into()),
        };

        // Old sessttl.45 jumps into the 50..=60 range at 50
        assert_eq!(calculate_next_rotation(50, Some(&mock_cfg_45)), 50);

        let mock_cfg_50 = Socks5Config {
            proxy_addr: "127.0.0.1:10000".parse().unwrap(),
            username: Some("acd0495816223c2984b0__cr.us;sessttl.50:b4c2f01cc617cda0".to_string()),
            password: Some("pass".into()),
        };
        assert_eq!(calculate_next_rotation(50, Some(&mock_cfg_50)), 51);

        let mock_cfg_59 = Socks5Config {
            proxy_addr: "127.0.0.1:10000".parse().unwrap(),
            username: Some("acd0495816223c2984b0__cr.us;sessttl.59:b4c2f01cc617cda0".to_string()),
            password: Some("pass".into()),
        };
        assert_eq!(calculate_next_rotation(50, Some(&mock_cfg_59)), 60);

        let mock_cfg_60 = Socks5Config {
            proxy_addr: "127.0.0.1:10000".parse().unwrap(),
            username: Some("acd0495816223c2984b0__cr.us;sessttl.60:b4c2f01cc617cda0".to_string()),
            password: Some("pass".into()),
        };
        // 60 wraps around to 50
        assert_eq!(calculate_next_rotation(50, Some(&mock_cfg_60)), 50);

        let bumped = bump_vsproxy_session(&mock_cfg_50, 50).expect("Should bump");
        let bumped_uname = bumped.username.unwrap();
        assert!(bumped_uname.contains("sessttl.51"));
        assert!(bumped_uname.contains("anon.1"));
    }

    #[test]
    fn test_resolve_subuser_id() {
        let cfg = VsProxyConfig::default();
        let mock_cfg = Socks5Config {
            proxy_addr: "127.0.0.1:10000".parse().unwrap(),
            username: Some("acd0495816223c2984b0__cr.us;sessttl.45".to_string()),
            password: Some("pass".into()),
        };

        let sub = resolve_subuser_id(&cfg, Some(&mock_cfg));
        assert_eq!(sub, Some("acd0495816223c2984b0".to_string()));
    }

    #[test]
    fn test_cooldown_enforcement() {
        let cfg = VsProxyConfig {
            cooldown_secs: 65,
            ..Default::default()
        };

        let recent = Instant::now() - Duration::from_secs(10);
        let err = roll_proxy(&cfg, None, Some(recent)).unwrap_err();
        match err {
            VsProxyError::Cooldown { remaining_secs } => {
                assert!(remaining_secs >= 50 && remaining_secs <= 56);
            }
            _ => panic!("Expected cooldown error, got {err:?}"),
        }
    }

    #[test]
    fn test_check_proxy_ip_handles_offline_proxy() {
        let mock_cfg = Socks5Config {
            proxy_addr: "127.0.0.1:1".parse().unwrap(),
            username: Some("user".into()),
            password: Some("pass".into()),
        };
        let res = check_proxy_ip(&mock_cfg);
        assert!(res.is_err());
    }

    #[test]
    fn test_auto_roll_env_parsing() {
        // If either AUTO_ROTATE_RECONNECT or VSPROXY_AUTO_ROLL is false, auto_roll should be false
        unsafe {
            std::env::set_var("AUTO_ROTATE_RECONNECT", "true");
            std::env::set_var("VSPROXY_AUTO_ROLL", "false");
        }
        let cfg = VsProxyConfig::from_env().unwrap();
        assert_eq!(cfg.auto_roll, false);

        unsafe {
            std::env::set_var("AUTO_ROTATE_RECONNECT", "false");
            std::env::set_var("VSPROXY_AUTO_ROLL", "true");
        }
        let cfg2 = VsProxyConfig::from_env().unwrap();
        assert_eq!(cfg2.auto_roll, false);

        unsafe {
            std::env::set_var("AUTO_ROTATE_RECONNECT", "true");
            std::env::set_var("VSPROXY_AUTO_ROLL", "true");
        }
        let cfg3 = VsProxyConfig::from_env().unwrap();
        assert_eq!(cfg3.auto_roll, true);
    }
}
