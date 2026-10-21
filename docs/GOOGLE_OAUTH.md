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
    participant Chrome as Local Chrome (CDP) / CloakBrowser
    participant Web as Growtopia web / Google

    BE->>Web: 1. MINT — server_data.php → dashboard POST → google/redirect
    Note over BE,Web: one ureq::Agent = game's single WebView2 jar;<br/>fresh meta+rid per attempt, host/transport failover
    BE->>Chrome: 2. TAB — createTarget → seed cookies → startScreencast → navigate to authorize URL
    Chrome->>Web: loads accounts.google.com…
    BE->>UI: viewer_live=true (Open browser)
    loop login
        Chrome-->>UI: JPEG frames (screencast → broadcast → WS binary)
        UI-->>Chrome: mouse / keyboard (Input.*)
    end
    BE->>Chrome: 3. WATCH — Runtime.evaluate every 2 s
    Note over BE,Chrome: captures the /google/callback?code=… URL
    BE->>Web: 4. VALIDATE — checktoken on the mint jar
    Note over BE: on reject → copy browser cookies into the jar, retry
    Web-->>BE: Account Validated (accountType: google)
    Note over BE: persist ltoken bundle → google_oauth_tokens.jsonl;<br/>close tab (stopScreencast + closeTarget)
    UI->>BE: 5. SPAWN — POST /oauth/google/:id/spawn
    BE->>BE: spawn_ltoken(token|rid|mac|wk) → bot in-game
```

Why a real browser at steps 2–3: Google rejects OAuth from embedded webviews
and from automation-flagged user agents ("This browser or app may not be
secure"). A headed Chrome with a persistent profile is what the game does
with its own WebView2 store — and it keeps the Google session, so the
operator signs in once instead of every time.

## Browser provider (local Chrome by default)

`src/local_browser.rs` + `src/remote_view.rs`:

| Provider | When | How |
|---|---|---|
| `local-chrome` | default | Mori launches `chrome.exe` (or `msedge.exe`) with `--remote-debugging-port=0` and a dedicated profile at `data/chrome-profile`; the port is read from `DevToolsActivePort` |
| `cloak` | `CLOAKBROWSER_CDP_HTTP` set **and reachable** | the external CloakBrowser manager, as before |

`resolve_provider()` picks the CloakBrowser manager only when it actually
answers `/json/version` — otherwise it falls through to the local browser.
(Before, a configured-but-dead manager produced
`viewer open failed: io: Connection refused` and the login died there.)

Env overrides:

| Variable | Meaning |
|---|---|
| `MORI_BROWSER_PATH` | explicit browser executable |
| `MORI_BROWSER_PROFILE` | explicit profile directory (default `data/chrome-profile`) |
| `CLOAKBROWSER_CDP_HTTP` | external CloakBrowser manager (optional) |
| `CLOAKBROWSER_WS_HOST` | rewrite for container-internal WS hosts |

`GET /oauth/browser/status` reports which provider is in use, the browser
path and the profile directory. The Google tab in the UI shows it.

The profile is persistent: after the first Google login the session is
reused, so later logins only need the consent click.

## Automation marker (why Google says "may not be secure")

Chrome turns on the `AutomationControlled` blink feature as soon as
`--remote-debugging-port` is used, so every page in the login tab sees
`navigator.webdriver === true`. Google reads exactly that on the sign-in and
answers:

> Couldn't sign you in - This browser or app may not be secure.

The rejection is **server-side**: the browser lands on
`accounts.google.com/v3/signin/rejected` right after the credentials are
submitted. Mori detects that URL and fails the session immediately with an
actionable reason instead of bouncing between the identifier page and the
rejection page until the timeout.

### How Mori hides the marker

| Browser | How | Result |
|---|---|---|
| Mori's own Chrome | launched with `--disable-blink-features=AutomationControlled` | `navigator.webdriver === false` **and the getter stays native** (`function get webdriver() { [native code] }`) |
| External provider (CloakBrowser) | page patch before the first script (`STEALTH_SCRIPT`), the replacement getter is made to look native | same visible result |

**Do not patch the property when the launch flag is available.** A patched
getter (`()=>false`) is a tampering signature that anti-bot code can spot with
one `Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get.toString()`
call - and that alone was enough for Google to reject the sign-in.

The backend logs what the page actually sees:

```
[browser] navigator.webdriver=false (native getter, clean)   <- good
[browser] WARNING: navigator.webdriver=true - Google will reject the sign-in
[browser] navigator.webdriver=false but the getter is PATCHED ... <- tampering
```

If the log says `WARNING: ... =true`, an older Chrome instance is still running
(the stealth flag is a *launch* flag) - close every Chrome window and start
over.

## System browser mode + helper extension

The fallback when Google refuses the automated browser
("This browser or app may not be secure"). It is also the mode the real
Growtopia client uses: the sign-in happens in the **user's own browser**,
started by the OS, with no automation flags at all.

Three ways to get a browser without an automation surface:

| Button | What it does | Automation surface |
|---|---|---|
| **Open browser** | the in-app modal, driven by Mori over CDP | the automation marker is hidden (see above) |
| **Open in my browser** | the OS default browser gets the authorize URL | none at all |
| **Open in a clean Chrome** | Mori launches a dedicated Chrome (profile `data/chrome-profile-bare`) **without** a DevTools port | none at all (no `DevToolsActivePort` file is even created) |

All three end the same way: the result comes back through one of the
following.

1. **The helper extension** (automatic, recommended) —
   `assets/mori-extension/`, an unpacked MV3 extension:
   - a content script on `login.growtopiagame.com` detects the landing page
     (`{"status":"success","token":…}`),
   - the background worker asks Mori which session owns the OAuth `state`
     (`GET /oauth/google/lookup?state=…` → `{id, client_data, checktoken_url}`),
   - the content script runs the `checktoken` POST **inside the page**, so it
     carries the browser's session cookie (no jar split),
   - the worker reports the result: `POST /oauth/google/{id}/landing`.
2. **Manual paste** — the landing page shows the token; copy it into the
   "Paste landing token" field (the existing `/oauth/google/:id/token`).

### Installing the extension (once)

```
chrome://extensions → Developer mode → Load unpacked
→ select <Mori folder>/assets/mori-extension
```

Then open the extension's options and paste the API token (the Google tab in
the Mori UI has a **Copy API token for the extension** button) plus the
backend address (default `http://127.0.0.1:3000`).

The extension only talks to `127.0.0.1` and `login.growtopiagame.com`.

### Endpoints

| Route | Purpose |
|---|---|
| `POST /oauth/google/{id}/open` | open the authorize URL in the default browser |
| `POST /oauth/google/{id}/open-bare` | open it in a bare Chrome (no DevTools port) |
| `GET /oauth/google/lookup?state=…` | session lookup by OAuth `state` (extension) |
| `POST /oauth/google/{id}/landing` | the extension reports the validated token |

## Phase 1 — Mint (`src/google_oauth.rs`)

`POST /oauth/google/start` runs `mint_with_backoff` on a blocking thread
(3 attempts, 10/30/60 s backoff between them):

1. **`server_data.php`** with the client UA → game server endpoint config
   (and the `meta` value).
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

### Host + transport failover

`growtopia1.com` sits behind Akamai, which answers
`403 Access Denied` to datacenter / VPN IPs and rate-limits bursts. The mint
leg therefore walks a candidate list instead of hardcoding one host:

```
(proxy, growtopia1.com) → (proxy, growtopia2.com) → (direct, growtopia1.com) → (direct, growtopia2.com)
```

The winning candidate is used for the whole chain (the `meta` and the
dashboard POST must come from the same IP). A 403/429/5xx is `Retryable`,
not fatal, and the error message names the host and the reason. Both
`server_data.php` hosts serve the identical payload — this mirrors the
legacy bot path (`src/bot/auth.rs`), which already flipped between them.

One `ureq::Agent` per OAuth session holds the single cookie jar across
dashboard → redirect → callback → checktoken — mirroring the game's single
WebView2 store (report 07 §3). Splitting jars is the #1 validation failure
(see "Jar split" below).

The response returns `{ id, authorize_url, seed_cookies, status, ltoken: null }`.
The status is `watching` while the browser leg runs; when no browser is
available at all the session stays `waiting_browser` and the manual
endpoints remain usable.

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
- The `/google/callback?code=…` URL is captured the moment the browser lands
  on it (it carries the Google `code`).
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

### Jar split (handled automatically)

The browser completes the callback in *its* cookie store while the validation
runs on the *mint* agent. When the server rejects that, Mori copies the
browser's cookies (`Network.getCookies` for `login.growtopiagame.com`) into
its own jar and retries the validation with the same landing token — the
jar split no longer needs a manual paste.

The `/google/callback` URL is only replayed on Mori's jar when the browser
produced **no** token at all: the Google `code` is single-use, so replaying
it after the browser already exchanged it would fail.

Manual fallbacks stay available: `POST /oauth/google/:id/callback` (paste the
callback URL) and `POST /oauth/google/:id/token` (paste the landing token).

## Phase 5 — Spawn

`POST /oauth/google/:id/spawn` (optionally with a proxy — same fields as
start) feeds `ltoken_bundle()` into the existing `spawn_ltoken` manager path.
409-vs-404 semantics: unknown session → 404, unvalidated session → 409.

## Session lifecycle

Statuses: `waiting_browser` (minted, no browser available) -> `watching`
(browser leg) -> `validating` (exchange) -> `validated {token, account_type}` |
`failed {reason}`. Double-validation and concurrent exchanges are rejected at
checkout.

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

The tab also shows which browser provider is in use (`local Chrome - <path>`).

## Setup

Nothing to configure for the default path: Mori finds `chrome.exe` /
`msedge.exe` and launches it with its own profile under `data/chrome-profile`.
Sign in to Google once in that window - the session is reused afterwards.

```bash
# Optional: explicit browser executable / profile directory
MORI_BROWSER_PATH=/path/to/chrome.exe
MORI_BROWSER_PROFILE=data/chrome-profile

# Optional: external CloakBrowser manager (used when it is reachable)
CLOAKBROWSER_CDP_HTTP=http://localhost:8080/api/profiles/<profile-id>/cdp
# Optional: manager advertises container-internal WS hosts; rewrite to reach it:
# CLOAKBROWSER_WS_HOST=localhost:8080
```

Compose reaches the laptop's CloakBrowser via `host.docker.internal`
(`host-gateway` mapping + `CLOAKBROWSER_*` passthrough in `docker-compose.yml`).
In Docker, run the browser on the host and point `CLOAKBROWSER_CDP_HTTP` at it
(a container cannot start the host's Chrome).
Keep the browser window headed — headless draws extra Google challenges.

## REST (behind the existing auth middleware)

```bash
BASE=http://localhost:3000
AUTH="Authorization: Bearer <mori-token>"

# 1. mint (+ auto browser leg; watch_timeout_secs optional)
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

# system browser mode: open the authorize URL in the default browser
curl -s -H "$AUTH" -X POST $BASE/oauth/google/<id>/open
# → { opened: true }

# provider health
curl -s -H "$AUTH" $BASE/oauth/browser/status
# → { configured, reachable, page_ws_found, detail, provider, browser_path, profile_dir }
```

Manual fallbacks (no browser, or a jar-split reject that survived the automatic
cookie sync):

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
| `viewer open failed: io: Connection refused` | `CLOAKBROWSER_CDP_HTTP` points at a manager that is not running | Mori now falls back to the local Chrome; unset the variable (or start the manager) |
| `This browser or app may not be secure` | Google rejected the browser context server-side (`/v3/signin/rejected`) | Check the backend log for `navigator.webdriver=false (native getter, clean)`; close every Chrome window started earlier (the stealth flag is a launch flag) and start over. Still refused? Use **Open in my browser** or **Open in a clean Chrome** (no automation at all) + the helper extension. |
| `no Chrome/Edge found - set MORI_BROWSER_PATH` | No browser executable on this machine | Install Chrome/Edge or set `MORI_BROWSER_PATH` |
| `login mint failed after 3 attempts: ... http status: 403` | Akamai blocks the IP on `growtopia1.com` | Automatic: the mint walks gt1 → gt2 → direct; if it still fails, use a residential proxy or a direct connection |
| `viewer open failed: cdp Page.startScreencast error -32000` | Fresh tab not attached yet | Retried internally (12 × 250 ms); if it persists past ~3 s, the browser is overloaded — retry Start |
| Slow "connecting… → streaming" | Tab creation / attach / heavy Google page | Check backend `[viewer] screencast up in … / navigate sent in …` to see which leg is slow |
| Modal spinner forever, `viewer_live: false` | Tab died or session failed/timed out | Read the failure `reason` in the Google tab; start over (states are single-use) |
| `GET …/view` → 404 | No live viewer: tab closed (validated/failed) or session evicted | Poll session status; re-mint if terminal |
| Modal reconnects forever after close | Tab closed while modal open | Expected — close the modal; status poll shows the terminal state |
| `session already validated` / `exchange already in progress` | Double-submit | One exchange per session; start over for a new login |
| Checktoken reject after the browser leg | Jar split (callback cookies live in the browser profile, not the mint jar) | Handled automatically (browser cookies are copied into the jar and the validation is retried); if it still fails, paste the `/google/callback` URL via the callback endpoint |
| `failed/try-again` from dashboard | One shared envelope for throttle-, stale-state-, and shape-rejects | Diagnose by what changed (freshness, cookies, content-type), not the message; keep attempts low |
| `no success token seen before timeout` | Login not completed in time, or state spent | Complete login faster or raise `watch_timeout_secs`; states expire fast — re-mint |
| `[browser] tab connection lost` | Tab closed externally / browser restarted | Restart with a fresh mint |

## Security notes

- `data/google_oauth_tokens.jsonl` and `data/user.json` are live secrets —
  never commit `data/` (0600 on the token log is damage control, not sharing).
- `seed_cookies` / landing tokens in API responses are bearer-equivalent;
  all `/oauth/*` routes sit behind the existing auth middleware (WS via
  `?token=`, same pattern as the event socket).
- The viewer exposes no navigation primitive — a compromised modal can only
  click/type into the login tab it was opened for.
- `data/chrome-profile` holds the Google session of the dedicated browser
  profile (it is inside `data/`, which is git-ignored). Treat it like a
  password — anyone with access to it can log into that Google account.
- The helper extension holds the Mori API token in `chrome.storage.sync`
  (synced to the user's Google account). Anyone with access to that profile
  can call the Mori API — keep the token out of shared machines.

## Notes / limits

- Token TTL / refresh schedule is unmeasured — run `refresh` daily and record
  when it dies.
- One dedicated tab per session in the shared browser profile (no per-login
  `BrowserContext` isolation yet); cap concurrent logins accordingly.
- The local Chrome instance stays running between sessions (the profile keeps
  the Google session); close it by hand when you are done.
- Phase 2 (not built): per-login `BrowserContext` isolation, gRPC surface.
