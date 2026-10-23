use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, RwLock},
};
use uuid::Uuid;

// ── Persistent credential store ───────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct UserRecord {
    /// Argon2id PHC string
    password_hash: String,
}

fn user_path() -> PathBuf {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("data")
        .join("user.json")
}

fn load_user() -> Option<UserRecord> {
    let path = user_path();
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_user(record: &UserRecord) -> anyhow::Result<()> {
    let path = user_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(record)?;
    std::fs::write(path, data)?;
    Ok(())
}

// ── Auth state (shared across requests) ──────────────────────────────────────

#[derive(Clone)]
pub struct AuthState {
    inner: Arc<RwLock<AuthInner>>,
}

struct AuthInner {
    /// None means not yet set up.
    password_hash: Option<String>,
    /// Active session token (single-user, single-session).
    /// Active session tokens. A set (not a single token), so a phone and the
    /// PC can be logged in at the same time without kicking each other out.
    sessions: HashSet<String>,
}

/// How many devices may be logged in at the same time (PC + phone + …).
const MAX_SESSIONS: usize = 16;

impl AuthState {
    pub fn new() -> Self {
        let password_hash = load_user().map(|u| u.password_hash);
        Self {
            inner: Arc::new(RwLock::new(AuthInner {
                password_hash,
                sessions: HashSet::new(),
            })),
        }
    }

    pub fn is_registered(&self) -> bool {
        self.inner.read().unwrap().password_hash.is_some()
    }

    pub fn register(&self, password: &str) -> anyhow::Result<()> {
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| anyhow::anyhow!("hash error: {}", e))?
            .to_string();

        save_user(&UserRecord {
            password_hash: hash.clone(),
        })?;

        let mut inner = self.inner.write().unwrap();
        inner.password_hash = Some(hash);
        inner.sessions.clear();
        Ok(())
    }

    pub fn login(&self, password: &str) -> Option<String> {
        let inner = self.inner.read().unwrap();
        let hash_str = inner.password_hash.as_deref()?;

        let parsed = PasswordHash::new(hash_str).ok()?;
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .ok()?;

        drop(inner);

        let token = Uuid::new_v4().to_string();
        let mut inner = self.inner.write().unwrap();
        // Keep the cap: drop the oldest session when it is reached.
        if inner.sessions.len() >= MAX_SESSIONS
            && let Some(old) = inner.sessions.iter().next().cloned()
        {
            inner.sessions.remove(&old);
        }
        inner.sessions.insert(token.clone());
        Some(token)
    }

    /// Returns true when the given token matches an active session.
    pub fn validate_token(&self, token: &str) -> bool {
        self.inner.read().unwrap().sessions.contains(token)
    }

    /// Drop one session (the caller's own) - or all of them when no token is
    /// given.
    pub fn logout(&self, token: Option<&str>) {
        let mut inner = self.inner.write().unwrap();
        match token {
            Some(t) => {
                inner.sessions.remove(t);
            }
            None => inner.sessions.clear(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_are_independent() {
        let auth = AuthState::new();
        let a = "token-a".to_string();
        let b = "token-b".to_string();
        {
            let mut inner = auth.inner.write().unwrap();
            inner.sessions.insert(a.clone());
            inner.sessions.insert(b.clone());
        }
        assert!(auth.validate_token(&a));
        assert!(auth.validate_token(&b));

        // Logging out on one device keeps the other one alive.
        auth.logout(Some(&a));
        assert!(!auth.validate_token(&a));
        assert!(auth.validate_token(&b));

        auth.logout(None);
        assert!(!auth.validate_token(&b));
    }
}
