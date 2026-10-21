// Mori login helper - content script.
//
// Runs on the Growtopia login pages. When the Google sign-in finishes, the
// server renders a JSON landing page:
//
//   {"status":"success","token":"<session token>", ...}
//
// The script hands that token to the background worker, which asks Mori for
// the matching session (by the OAuth `state`). The checktoken POST then runs
// *here*, in the page context, so it carries the browser's session cookie -
// the server rejects a checktoken that comes from a different session.

(function () {
  let done = false;

  function parseLanding(text) {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return null;
    let json;
    try {
      json = JSON.parse(trimmed);
    } catch (_) {
      return null;
    }
    if (!json || json.status !== "success" || !json.token) return null;
    return json;
  }

  async function handle() {
    if (done) return;
    const json = parseLanding(document.body ? document.body.innerText : "");
    if (!json) return;
    done = true;

    const state = new URL(location.href).searchParams.get("state") || "";
    const cfg = await chrome.runtime.sendMessage({
      kind: "landing",
      token: json.token,
      state,
      url: location.href,
    });

    if (!cfg || !cfg.ok) {
      await chrome.runtime.sendMessage({
        kind: "report",
        id: null,
        token: json.token,
        error: (cfg && cfg.error) || "no active Mori session for this login",
      });
      return;
    }

    // Same-origin POST: the browser's session cookie is attached, so the
    // server sees one session (no jar split).
    const body = new URLSearchParams();
    body.set("refreshToken", json.token);
    body.set("clientData", cfg.client_data);

    try {
      const res = await fetch(cfg.checktoken_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        credentials: "include",
      });
      const result = await res.json().catch(() => null);
      await chrome.runtime.sendMessage({
        kind: "report",
        id: cfg.id,
        token: (result && result.token) || json.token,
        account_type: (result && result.accountType) || "",
        error: result && result.status !== "success" ? JSON.stringify(result) : "",
      });
    } catch (e) {
      await chrome.runtime.sendMessage({
        kind: "report",
        id: cfg.id,
        token: json.token,
        error: String(e),
      });
    }
  }

  function schedule() {
    handle().catch(() => {});
  }

  schedule();
  if (document.body) {
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(() => mo.disconnect(), 120000);
  }
  setTimeout(schedule, 1500);
  setTimeout(schedule, 5000);
})();
