# Google OAuth login (browser-assisted)

Ports `growtopia-bots/sandbox/demo_google_login.py` + `cloak_google_login.py`
(reports `06-google-login-replication.md`, `07-cloakbrowser-login-automation.md`)
and the CDP discovery rules from `remote-browser/docs/CLOAKBROWSER.md`.

Legacy GrowID login (`POST /bots` with username+password) is untouched.
Google login mints the same session-token shape and spawns through the
existing ltoken path (`token|rid|mac|wk`, same string `Bot::new_ltoken` parses).

## Big picture

```mermaid
sequenceDiagram
    participant UI as Mori UI (modal)
    participant BE as Mori backend
    participant Cloak as CloakBrowser tab (CDP)
    participant Web as Growtopia web / Google

    BE->>Web: 1. MINT — server_data.php → dashboard POST → google/redirect
    Note over BE,Web: one ureq::Agent = game's single WebView2 jar;<br/>fresh meta+rid per attempt, backoff on throttle
    BE->>Cloak: 2. TAB — createTarget → seed cookies → startScreencast → navigate to authorize URL
    Cloak->>Web: loads accounts.google.com…
    BE->>UI: viewer_live=true (Open browser)
    loop login
        Cloak-->>UI: JPEG frames (screencast → broadcast → WS binary)
        UI-->>Cloak: mouse / keyboard (Input.*)
    end
    BE->>Cloak: 4. WATCH — Runtime.evaluate every 2 s
    Cloak-->>BE: landing page {"status":"success","token"}
    BE->>Web: 5. VALIDATE — checktoken on the mint jar
    Web-->>BE: Account Validated (accountType: google)
    Note over BE: persist ltoken bundle → google_oauth_tokens.jsonl;<br/>close tab (stopScreencast + closeTarget)
    UI->>BE: 6. SPAWN — POST /oauth/google/:id/spawn
    BE->>BE: spawn_ltoken(token|rid|mac|wk) → bot in-game
```

Why a real stealth browser at steps 2–3: Google 403s WebView2, embedded, and
headless browsers. CloakBrowser is a headed stealth Chromium profile; Mori
drives one dedicated tab inside it over CDP and remotes that tab into Mori's
UI — the operator never touches the CloakBrowser window.

## Phase 1 — Mint (`src/google_oauth.rs`)

`POST /oauth/google/start` runs `mint_with_backoff` on a blocking thread
(3 attempts, 10/30/60 s backoff on the throttle envelope):

1. **`server_data.php`** with the client UA → game server endpoint config.
2. **Dashboard POST** with a WebView2 Chrome UA, the game's custom
   percent-encoding table (`client_percent_encode`, byte-exact vs the client),
   and a **fresh `meta` + `rid` per attempt**. In-game `(game_version,
   protocol)` comes from `src/constants.rs` (currently `5.59/225`) — single
   source of truth, also used for the OAuth descriptor.
3. **`google/redirect?token=`** href → follows the 302 to
   `accounts.google.com/o/oauth2/auth` and parses the authorize params
   (`parse_authorize_url` rejects embedded/foreign hosts).
4. Builds the **OAuth descriptor** (`build_descriptor`: `raw`/`rid`/`mac`/`wk`
   + `hash_string("RT")`) and **exports seed cookies** (`export_seed_cookies`)
   for the browser tab.

One `ureq::Agent` per OAuth session holds the single cookie jar across
dashboard → redirect → callback → checktoken — mirroring the game's single
WebView2 store (report 07 §3). Splitting jars is the #1 validation failure
(see "Jar split" below).

The response returns `{ id, authorize_url, seed_cookies, status, ltoken: null }`.
With `CLOAKBROWSER_CDP_HTTP` set, status is `watching` (browser leg auto-starts);
without it, `waiting_browser` and the session waits for the manual endpoints.

## Phase 2 — Login tab (`src/remote_view.rs`)

`RemoteViewer::open()` runs, in order:

1. `GET {cdp}/json/version` → browser WS URL (host rewritten via
   `CLOAKBROWSER_WS_HOST` when the manager advertises container-internal hosts).
2. `Target.createTarget {url: about:blank}` on the browser WS → isolated
   tab. Falls back to the profile's existing page if creation fails.
3. Poll `GET {cdp}/json/list` (20 × 250 ms) for the new target's page WS
   (creation → listing races).
4. `Network.enable`, then one `Network.setCookie` per seed cookie with `url`
   pinning the login host (Chromium derives domain/path from it —
   `Storage.setCookies` rejects these partials).
5. `Page.enable`, then `Page.startScreencast {jpeg, q75, maxWidth:1280,
   everyNthFrame:1}` **before** navigate — a blank tab attaches faster than a
   loading Google page, and the stream survives navigation. Fresh tabs race
   `Not attached to an active page`, so it retries 12 × 250 ms. Backend logs
   `[viewer] screencast up in … / navigate sent in …` for timing diagnosis.
6. `Page.navigate` to the authorize URL.

### Viewer protocol (`GET /oauth/google/:id/view`, WS)

Auth via `?token=` (same middleware exception as the event `/ws`). One
broadcast channel (cap 8, lagging viewers skip) fans JPEG frames out to every
attached modal.

| Direction | Shape | Notes |
|---|---|---|
| down (binary) | JPEG bytes | `Page.screencastFrame` → broadcast → WS binary. Acked with the **verbatim** `params.sessionId` (integer or string — never coerced) or the stream stalls. |
| up (text) | `{t:"move"/"down"/"up"/"click", x, y, button?, fw?, fh?}` | Frame px → page CSS px via live `Page.getLayoutMetrics` (10 s TTL). `click` = press + release. Non-passive `wheel` included. |
| up (text) | `{t:"key", kind:"down"/"up", key, code, text?}` | Non-printable only. |
| up (text) | `{t:"type", text}` | **All printable typing goes here** (`Input.insertText`). Sending printables as key events duplicates characters. |

There is deliberately **no `goto`**: the tab is allowlisted to the authorize
URL the server navigated to. Token detection is headless and keeps working
with zero viewers attached — closing the modal never aborts the login.

## Phase 3 — Watch (`watch_for_token`)

The background leg polls the tab every 2 s until `watch_timeout_secs`
(default 600, clamped 60–3600, settable per-start):

- `location.href` → nav logging (`[browser] nav …`) + one-shot operator hints
  (`accounts.google.com` → log in/consent; `/logon-name` → new account needs a
  display name; `profile-conflict` → link/merge choice; `modalShow` → dismiss
  the popup).
- `document.body.innerText` → **strict** `{"status":"success","token"}` JSON
  parse (rejects shape-alikes).
- Loose-regex fallback on `outerHTML`/URL **only** while on `/google/callback`
  (report 07 §4).
- 20 s heartbeat log while waiting.
- Fail-fast if the tab connection drops (`[browser] tab connection lost`),
  instead of polling a dead socket to timeout.

Timeout (or dead tab) → status `failed`: the state is likely spent (states are
single-use, expire fast) — start over with a fresh mint.

## Phase 4 — Validate

`step_checktoken`: form-encoded checktoken POST **on the mint agent** with the
landing token + stored descriptor → `Account Validated`, token echoed back,
`accountType: google`. The validated `token|rid|mac|wk` bundle appears as the
session's `ltoken`, and appends (O_APPEND, no read-modify-write races) to
`data/google_oauth_tokens.jsonl` (mode 0600 — as powerful as the login).

Terminal states (`validated` / `failed`) tear down the tab: stop screencast +
`Target.closeTarget` on a best-effort task, so the response never blocks on it.

### Jar split

The cloak tab completes the callback in *its* profile while validation runs on
the *mint* agent. If the server rejects (jar-split symptom), paste the
`/google/callback?code&state` URL via `POST /oauth/google/:id/callback` — it
replays the callback fetch on the same jar, then validates.

## Phase 5 — Spawn

`POST /oauth/google/:id/spawn` (optionally with a proxy — same fields as
start) feeds `ltoken_bundle()` into the existing `spawn_ltoken` manager path.
409-vs-404 semantics: unknown session → 404, unvalidated session → 409.

## Session lifecycle

Statuses: `waiting_browser` (minted, no cloak) → `watching` (browser leg) →
`validating` (exchange) → `validated {token, account_type}` | `failed {reason}`.
Double-validation and concurrent exchanges are rejected at checkout.

- `viewer_live` tells the UI whether a modal can attach right now.
- Sessions are capped at 32 (terminal-first, oldest-wins eviction; an evicted
  live viewer gets its tab closed).
- The UI closes the modal automatically on `validated` (headless watch may
  beat the stream there); on `failed` it stays open so the reason is readable.

## UI walkthrough

Add Bot → **Google** tab → optional proxy → **Start Google login** → status
polls every 3 s → **Open browser** appears when `viewer_live` → complete
email → password → consent in the fullscreen modal (click the page to enable
typing; closing it keeps the login running — reopen from the tab) → modal
auto-closes on validated → **Spawn**. Callback-URL / landing-token fields and
`Refresh` cover the manual paths below.

## Setup

```bash
# CloakBrowser path (primary). Profile id from cloakbrowser-manager:
CLOAKBROWSER_CDP_HTTP=http://localhost:8080/api/profiles/<profile-id>/cdp
# Optional: manager advertises container-internal WS hosts; rewrite to reach it:
# CLOAKBROWSER_WS_HOST=localhost:8080
```

Compose reaches the laptop's CloakBrowser via `host.docker.internal`
(`host-gateway` mapping + `CLOAKBROWSER_*` passthrough in `docker-compose.yml`).

Without `CLOAKBROWSER_CDP_HTTP`, mint still works and the session waits for
the manual endpoints below (same as the demo's `--token`/`--callback` modes).
Keep the CloakBrowser window headed — headless draws extra Google challenges.

## REST (behind the existing auth middleware)

```bash
BASE=http://localhost:3000
AUTH="Authorization: Bearer <mori-token>"

# 1. mint (+ auto CDP leg when cloak is configured; watch_timeout_secs optional)
curl -s -H "$AUTH" -X POST $BASE/oauth/google/start \
  -H 'Content-Type: application/json' -d '{}'
# → { id, authorize_url, seed_cookies, status: "watching"|"waiting_browser", ltoken: null }

# 2. poll (open the browser from the Google tab and complete login there)
curl -s -H "$AUTH" $BASE/oauth/google/<id>
# → status becomes validated with "ltoken": "EpWo…|rid|mac|wk", "viewer_live": false (tab closed)

# 3. spawn (proxy fields optional, same shape as start)
curl -s -H "$AUTH" -X POST $BASE/oauth/google/<id>/spawn \
  -H 'Content-Type: application/json' -d '{}'
# → { id: <bot_id>, oauth_id }

# provider health
curl -s -H "$AUTH" $BASE/oauth/browser/status
# → { configured, reachable, page_ws_found, detail }
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

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `viewer open failed: cdp Page.startScreencast error -32000` | Fresh tab not attached yet | Retried internally (12 × 250 ms); if it persists past ~3 s, cloak is overloaded — retry Start |
| Slow "connecting… → streaming" | Tab creation / attach / heavy Google page | Check backend `[viewer] screencast up in … / navigate sent in …` to see which leg is slow |
| Modal spinner forever, `viewer_live: false` | Tab died or session failed/timed out | Read the failure `reason` in the Google tab; start over (states are single-use) |
| `GET …/view` → 404 | No live viewer: tab closed (validated/failed) or session evicted | Poll session status; re-mint if terminal |
| Modal reconnects forever after close | Tab closed while modal open | Expected — close the modal; status poll shows the terminal state |
| `session already validated` / `exchange already in progress` | Double-submit | One exchange per session; start over for a new login |
| Checktoken reject after cloak leg | Jar split (callback cookies live in the cloak profile, not the mint jar) | Paste the `/google/callback` URL via the callback endpoint |
| `failed/try-again` from dashboard | One shared envelope for throttle-, stale-state-, and shape-rejects | Diagnose by what changed (freshness, cookies, content-type), not the message; keep attempts low |
| `no success token seen before timeout` | Login not completed in time, or state spent | Complete login faster or raise `watch_timeout_secs`; states expire fast — re-mint |
| `[browser] tab connection lost` | Tab closed externally / cloak restarted | Restart with a fresh mint |

## Security notes

- `data/google_oauth_tokens.jsonl` and `data/user.json` are live secrets —
  never commit `data/` (0600 on the token log is damage control, not sharing).
- `seed_cookies` / landing tokens in API responses are bearer-equivalent;
  all `/oauth/*` routes sit behind the existing auth middleware (WS via
  `?token=`, same pattern as the event socket).
- The viewer exposes no navigation primitive — a compromised modal can only
  click/type into the login tab it was opened for.

## Notes / limits

- Token TTL / refresh schedule is unmeasured — run `refresh` daily and record
  when it dies.
- One dedicated tab per session in the shared cloak profile (no per-login
  `BrowserContext` isolation yet); cap concurrent logins accordingly.
- Phase 2 (not built): per-login `BrowserContext` isolation, gRPC surface.
