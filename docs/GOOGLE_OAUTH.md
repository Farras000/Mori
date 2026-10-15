# Google OAuth login (browser-assisted)

Ports `growtopia-bots/sandbox/demo_google_login.py` + `cloak_google_login.py`
(reports `06-google-login-replication.md`, `07-cloakbrowser-login-automation.md`)
and the CDP discovery rules from `remote-browser/docs/CLOAKBROWSER.md`.

Legacy GrowID login (`POST /bots` with username+password) is untouched.
Google login mints the same session-token shape and spawns through the
existing `POST /bots/ltoken` path (`token|rid|mac|wk`).

## How it works

1. Mori mints a fresh dashboard session server-side with the in-game
   `(game_version, protocol)` pair from `src/constants.rs` (currently
   `5.59/225`): `server_data.php` (client UA) →
   dashboard POST (WebView2 Chrome UA, custom percent-encoding, fresh
   `meta`+`rid` per attempt, backoff 10/30/60 s on the throttle envelope) →
   `google/redirect?token=` href → 302 `accounts.google.com/o/oauth2/auth`.
2. One `ureq::Agent` per OAuth session = the game's single WebView2 cookie
   store (dashboard → redirect → callback → checktoken share one jar;
   report 07 §3).
3. The Google consent itself runs in a **dedicated CloakBrowser tab** driven
   by Mori over CDP (`src/remote_view.rs`: per-session `Target.createTarget`,
   `Network.setCookie` seed, `Page.navigate`, `Page.startScreencast`). You
   complete email → password → consent (+ name-pick / link-choice if asked)
   inside Mori's browser modal — frames stream to the modal over
   `GET /oauth/google/:id/view`, input goes back as `Input.*` (frame-px mapped
   via live `getLayoutMetrics`; typing via `insertText` only). No `goto` from
   the viewer: the tab is allowlisted to the authorize URL. (Google 403s
   WebView2/embedded/headless browsers, hence stealth Chromium.)
4. Landing token → form-encoded `checktoken` on the same jar →
   `Account Validated` (token echoed back, `accountType: google`).
   Validated bundles persist (append) to `data/google_oauth_tokens.jsonl`
   (mode 0600 — as powerful as the login).

## Setup

```bash
# CloakBrowser path (primary). Profile id from cloakbrowser-manager:
CLOAKBROWSER_CDP_HTTP=http://localhost:8080/api/profiles/<profile-id>/cdp
# Optional: manager advertises container-internal WS hosts; rewrite to reach it:
# CLOAKBROWSER_WS_HOST=localhost:8080
```

Without `CLOAKBROWSER_CDP_HTTP`, mint still works and the session waits for
the manual endpoints below (same as the demo's `--token`/`--callback` modes).
Keep the CloakBrowser window headed — headless draws extra Google challenges.

## REST (behind the existing auth middleware)

```bash
BASE=http://localhost:3000
AUTH="Authorization: Bearer <mori-token>"

# 1. mint (+ auto CDP leg when cloak is configured)
curl -s -H "$AUTH" -X POST $BASE/oauth/google/start \
  -H 'Content-Type: application/json' -d '{}'
# → { id, authorize_url, seed_cookies, status: "watching"|"waiting_browser", ltoken: null }

# 2. poll (open the browser from the Google tab and complete login there)
curl -s -H "$AUTH" $BASE/oauth/google/<id>
# → status becomes validated with "ltoken": "EpWo…|rid|mac|wk", "viewer_live": false (tab closed)

# 3. spawn
curl -s -H "$AUTH" -X POST $BASE/oauth/google/<id>/spawn \
  -H 'Content-Type: application/json' -d '{}'
# → { id: <bot_id>, oauth_id }

# provider health
curl -s -H "$AUTH" $BASE/oauth/browser/status
```

Manual fallbacks (no cloak, or jar-split reject after the cloak leg):

```bash
# same-jar callback fetch (preferred manual path — mirrors single WebView2 store)
curl -s -H "$AUTH" -X POST $BASE/oauth/google/<id>/callback \
  -H 'Content-Type: application/json' \
  -d '{"callback_url":"https://login.growtopiagame.com/google/callback?code=…&state=…"}'

# landing-token paste (demo --token equivalent; can hit the jar-split reject)
curl -s -H "$AUTH" -X POST $BASE/oauth/google/<id>/token \
  -H 'Content-Type: application/json' -d '{"token":"EpWo…"}'

# browserless re-login (demo --refresh equivalent, single POST, no browser)
curl -s -H "$AUTH" -X POST $BASE/oauth/google/<id>/refresh
```

The `seed_cookies` array in the session view is for manual import
(DevTools → Application → Cookies → `login.growtopiagame.com`) when driving
an external browser by hand.

## Notes / limits

- Dashboard throttle shares one `failed/try-again` envelope for
  throttle-rejects, stale-state rejects, and shape-rejects — diagnose by what
  changed (freshness, cookies, content-type), not the message. Keep total
  attempts low; mint is fresh-by-default, states are single-use and expire fast.
- Token TTL / refresh schedule is unmeasured — run `refresh` daily and record
  when it dies.
- The cloak exchange validates on the mint agent; if the server rejects with
  the jar-split symptom, paste the `/google/callback` URL via the callback
  endpoint (replays the callback fetch on the same jar, then validates).
- Phase 2 (not built): per-login `BrowserContext` isolation (currently one
  dedicated tab per session in the shared profile), gRPC surface.
