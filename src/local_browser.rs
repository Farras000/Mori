//! Local Chrome/Edge provider for the Google-login browser leg.
//!
//! Growtopia's own desktop client embeds the Google sign-in inside the game.
//! Mori reproduces that with a **real** browser instead of an embedded webview:
//! a local Chrome (or Edge) is launched with a dedicated, persistent profile
//! (`data/chrome-profile`) and a DevTools port, then the existing
//! [`crate::remote_view`] CDP client drives one dedicated tab of it.
//!
//! Why a real browser (not WebView2):
//! - Google rejects OAuth from embedded webviews / automation-flagged
//!   user agents ("This browser or app may not be secure").
//! - A persistent profile keeps the Google session: the operator signs in
//!   once, every later login is a single click.
//!
//! The provider is optional: when `CLOAKBROWSER_CDP_HTTP` points at a
//! *reachable* CDP endpoint, that provider wins (see
//! [`crate::remote_view::resolve_provider`]). Otherwise the local browser is
//! launched on demand.
//!
//! Env overrides:
//! - `MORI_BROWSER_PATH` — explicit browser executable (chrome/edge).
//! - `MORI_BROWSER_PROFILE` — explicit profile directory.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Explicit browser executable (Chrome or Edge).
pub const BROWSER_ENV: &str = "MORI_BROWSER_PATH";
/// Explicit profile directory for the dedicated login profile.
pub const PROFILE_ENV: &str = "MORI_BROWSER_PROFILE";

/// File Chrome writes into the user-data-dir when `--remote-debugging-port=0`
/// is used: first line = port, second line = browser websocket path.
const DEVTOOLS_PORT_FILE: &str = "DevToolsActivePort";

/// Candidate executables, in priority order (Chrome first — the game itself
/// is a Chromium app, and Chrome keeps its profile format stable).
fn candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut roots: Vec<PathBuf> = Vec::new();
    for r in [&pf, &pf86, &local] {
        if r.is_empty() {
            continue;
        }
        roots.push(PathBuf::from(r));
    }
    for root in roots {
        out.push(root.join("Google").join("Chrome").join("Application").join("chrome.exe"));
        out.push(root.join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
    }
    // PATH lookup as the last resort.
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            for exe in ["chrome.exe", "msedge.exe"] {
                let p = dir.join(exe);
                if p.is_file() {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// The configured browser executable, when `MORI_BROWSER_PATH` is set.
///
/// An explicit path is exclusive: when it does not exist the lookup fails
/// instead of silently using a different browser.
pub fn configured_browser() -> Option<PathBuf> {
    let p = std::env::var(BROWSER_ENV).ok()?.trim().to_string();
    if p.is_empty() {
        return None;
    }
    Some(PathBuf::from(p))
}

/// First existing browser executable, if any.
pub fn find_browser() -> Option<PathBuf> {
    if let Some(explicit) = configured_browser() {
        return explicit.is_file().then_some(explicit);
    }
    candidate_paths().into_iter().find(|p| p.is_file())
}

/// Dedicated profile directory (`data/chrome-profile` by default).
///
/// Always resolved to an **absolute** path: Chrome silently skips the
/// DevTools port file when `--user-data-dir` is relative (verified on
/// Chrome 155 — the browser starts but never exposes its port).
pub fn profile_dir() -> PathBuf {
    let raw = std::env::var(PROFILE_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "data/chrome-profile".to_string());
    let path = PathBuf::from(raw);
    std::path::absolute(&path).unwrap_or(path)
}

/// Port from the profile's `DevToolsActivePort` file, when present.
pub fn running_port(profile: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(profile.join(DEVTOOLS_PORT_FILE)).ok()?;
    let first = raw.lines().next()?.trim();
    first.parse::<u16>().ok()
}

/// True when the DevTools endpoint actually answers (the port file can be
/// stale after a Chrome crash).
pub fn port_is_live(port: u16) -> bool {
    ureq::get(&format!("http://127.0.0.1:{port}/json/version"))
        .config()
        .timeout_global(Some(Duration::from_millis(800)))
        .build()
        .call()
        .is_ok()
}

/// Live local browser, if one is already running with our profile.
pub fn existing_session() -> Option<(PathBuf, u16)> {
    let profile = profile_dir();
    let port = running_port(&profile)?;
    if port_is_live(port) {
        Some((profile, port))
    } else {
        None
    }
}

/// Keep spawned children alive for the process lifetime (dropping a `Child`
/// on Windows does not kill the process, but holding the handle keeps the
/// exit status readable and stops zombie bookkeeping).
fn children() -> &'static Mutex<Vec<Child>> {
    static CHILDREN: OnceLock<Mutex<Vec<Child>>> = OnceLock::new();
    CHILDREN.get_or_init(|| Mutex::new(Vec::new()))
}

/// Chrome flags for the dedicated login browser.
///
/// `--disable-blink-features=AutomationControlled` is **required**: Chrome
/// enables the `AutomationControlled` blink feature whenever
/// `--remote-debugging-port` is used, so pages see
/// `navigator.webdriver === true`. Google reads that and refuses the sign-in
/// with "This browser or app may not be secure" (measured on Chrome 155).
///
/// The flag is preferred over patching `navigator.webdriver` from the page:
/// with the flag the property keeps its **native** getter
/// (`function get webdriver() { [native code] }`), while a patched getter
/// (`()=>false`) is a visible tampering signature that anti-bot code can spot
/// with one `Object.getOwnPropertyDescriptor(...)` call.
///
/// The rest keeps the profile quiet and the renderer alive while the tab is
/// in the background (the screencast needs frames).
pub fn launch_args(profile: &Path) -> Vec<String> {
    vec![
        "--remote-debugging-port=0".to_string(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-blink-features=AutomationControlled".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-backgrounding-occluded-windows".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-features=Translate,OptimizationHints,MediaRouter".to_string(),
        "--window-size=1280,900".to_string(),
        "about:blank".to_string(),
    ]
}

/// Chrome flags for the **bare** login browser.
///
/// No `--remote-debugging-port`, no automation flags: a completely ordinary
/// Chrome that Google cannot tell apart from a human's browser. Mori cannot
/// drive it (no CDP), so the sign-in is finished by hand and the result comes
/// back through the helper extension or a pasted token.
pub fn bare_launch_args(profile: &Path, url: &str) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--window-size=1280,900".to_string(),
        url.to_string(),
    ]
}

/// Profile of the bare browser (separate from the CDP one: Chrome locks a
/// profile directory, so both cannot run at the same time).
pub fn bare_profile_dir() -> PathBuf {
    let base = profile_dir();
    base.parent()
        .map(|p| p.join("chrome-profile-bare"))
        .unwrap_or_else(|| PathBuf::from("data").join("chrome-profile-bare"))
}

/// Launch the browser with a DevTools port and wait until it answers.
///
/// Returns `(exe, port)`. An already-running instance with the same profile
/// is reused instead of spawning a second one.
pub fn ensure_started() -> anyhow::Result<(PathBuf, u16)> {
    let exe = find_browser().ok_or_else(|| {
        if let Some(p) = configured_browser() {
            return anyhow::anyhow!("{} does not exist ({} set)", p.display(), BROWSER_ENV);
        }
        anyhow::anyhow!(
            "no Chrome/Edge found (set {} to the browser executable)",
            BROWSER_ENV
        )
    })?;
    let profile = profile_dir();

    if let Some((_, port)) = existing_session() {
        return Ok((exe, port));
    }

    std::fs::create_dir_all(&profile)?;

    // `--remote-debugging-port=0` → Chrome picks a free port and writes it to
    // <user-data-dir>/DevToolsActivePort. A stale file from a previous run
    // would be read as "already running", so remove it before spawning.
    let port_file = profile.join(DEVTOOLS_PORT_FILE);
    let _ = std::fs::remove_file(&port_file);

    let child = Command::new(&exe)
        .args(launch_args(&profile))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| anyhow::anyhow!("failed to launch {}: {e}", exe.display()))?;

    // Keep the handle (the browser itself keeps running for later sessions).
    if let Ok(mut v) = children().lock() {
        v.push(child);
    }

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(port) = running_port(&profile)
            && port_is_live(port)
        {
            return Ok((exe, port));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    anyhow::bail!(
        "{} did not expose a DevTools port within 30s (profile {})",
        exe.display(),
        profile.display()
    )
}

/// Human-readable summary for the UI (never launches anything).
pub fn describe() -> (Option<String>, String) {
    let exe = find_browser().map(|p| p.display().to_string());
    let profile = profile_dir().display().to_string();
    (exe, profile)
}

/// Launch the **bare** browser (no DevTools port, no automation flags) and
/// open `url` in it. The operator finishes the sign-in in that window; the
/// result comes back through the helper extension or a pasted token.
pub fn open_bare_browser(url: &str) -> anyhow::Result<PathBuf> {
    let exe = find_browser().ok_or_else(|| {
        if let Some(p) = configured_browser() {
            return anyhow::anyhow!("{} does not exist ({} set)", p.display(), BROWSER_ENV);
        }
        anyhow::anyhow!(
            "no Chrome/Edge found (set {} to the browser executable)",
            BROWSER_ENV
        )
    })?;
    let profile = bare_profile_dir();
    std::fs::create_dir_all(&profile)?;
    let child = Command::new(&exe)
        .args(bare_launch_args(&profile, url))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| anyhow::anyhow!("failed to launch {}: {e}", exe.display()))?;
    if let Ok(mut v) = children().lock() {
        v.push(child);
    }
    Ok(profile)
}

/// Why no browser is available (for the status endpoint / error messages).
pub fn missing_reason() -> String {
    if let Some(p) = configured_browser() {
        if !p.is_file() {
            return format!("{} does not exist ({} set)", p.display(), BROWSER_ENV);
        }
    }
    format!(
        "no Chrome/Edge found - set {} to the browser executable",
        BROWSER_ENV
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_dir_defaults_under_data() {
        // Explicit env wins (and is resolved to an absolute path).
        unsafe {
            std::env::set_var(PROFILE_ENV, "data/test-profile");
        }
        let p = profile_dir();
        assert!(p.is_absolute(), "profile dir must be absolute: {p:?}");
        assert!(p.ends_with("data/test-profile"), "{p:?}");
        unsafe {
            std::env::remove_var(PROFILE_ENV);
        }
        let p = profile_dir();
        assert!(p.is_absolute(), "profile dir must be absolute: {p:?}");
        assert!(p.ends_with("data/chrome-profile"), "{p:?}");
    }

    #[test]
    fn launch_args_hide_automation_and_use_absolute_profile() {
        let profile = std::path::absolute("data/chrome-profile").unwrap();
        let args = launch_args(&profile);
        assert!(
            args.iter()
                .any(|a| a == "--disable-blink-features=AutomationControlled"),
            "Google refuses the sign-in when navigator.webdriver is true: {args:?}"
        );
        assert!(args.iter().any(|a| a == "--remote-debugging-port=0"));
        assert!(
            args.iter()
                .any(|a| a.starts_with("--user-data-dir=") && a.contains(profile.to_str().unwrap())),
            "user-data-dir must be absolute: {args:?}"
        );
    }

    #[test]
    fn bare_launch_args_have_no_automation_surface() {
        let profile = std::path::absolute("data/chrome-profile-bare").unwrap();
        let args = bare_launch_args(&profile, "https://accounts.google.com/o/oauth2/auth?a=1");
        assert!(
            !args.iter().any(|a| a.contains("remote-debugging")),
            "bare mode must not expose a DevTools port: {args:?}"
        );
        assert!(
            !args.iter().any(|a| a.contains("AutomationControlled")),
            "bare mode must not need the stealth flag: {args:?}"
        );
        assert!(args.iter().any(|a| a.starts_with("--user-data-dir=")));
        assert_eq!(args.last().unwrap(), "https://accounts.google.com/o/oauth2/auth?a=1");
    }

    #[test]
    fn running_port_parses_first_line() {
        let dir = std::env::temp_dir().join("mori-devtools-port-test");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(DEVTOOLS_PORT_FILE), "9222\n/devtools/browser/abc\n").unwrap();
        assert_eq!(running_port(&dir), Some(9222));
        std::fs::write(dir.join(DEVTOOLS_PORT_FILE), "not-a-port\n").unwrap();
        assert_eq!(running_port(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
