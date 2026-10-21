//! Open a URL in the user's default browser.
//!
//! The "system browser" path for the Google login: the browser is started by
//! the OS, with **no automation flags at all** (`navigator.webdriver` stays
//! `false` because the browser is not ours). Google cannot tell it apart from
//! a normal sign-in, and the user's own profile keeps the Google session.
//!
//! The sign-in then has to come back to Mori:
//! - the "Mori login helper" browser extension (see `assets/mori-extension`)
//!   reports the landing token automatically, or
//! - the operator pastes the token into the Mori UI (manual fallback).

use std::process::{Command, Stdio};

/// Open `url` in the default browser. Returns once the launcher was spawned.
pub fn open_default_browser(url: &str) -> anyhow::Result<()> {
    if url.trim().is_empty() {
        anyhow::bail!("empty url");
    }
    #[cfg(windows)]
    {
        // `start` treats `&` inside a quoted argument as part of the URL, so
        // the URL is quoted explicitly (the authorize URL is full of `&`).
        let quoted = format!("\"{}\"", url.replace('"', ""));
        Command::new("cmd")
            .args(["/C", "start", "", &quoted])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to open the default browser: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        Command::new("xdg-open")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| anyhow::anyhow!("failed to open the default browser: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_url_is_rejected() {
        assert!(open_default_browser("   ").is_err());
    }
}
