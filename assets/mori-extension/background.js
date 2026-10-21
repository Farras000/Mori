// Mori login helper - background service worker.
//
// Bridges the Growtopia sign-in page to the local Mori backend:
//   content.js  -> "landing"  (token + state seen on the landing page)
//                -> "report"   (result of the in-page checktoken)
// The worker owns the Mori API calls so the content script stays a thin
// page-context script (the checktoken must run in the page: the server
// checks the browser session cookie).

const DEFAULTS = { base: "http://127.0.0.1:3000", token: "" };

async function conf() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { base: (stored.base || DEFAULTS.base).replace(/\/+$/, ""), token: stored.token || "" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.kind === "landing") {
        const c = await conf();
        if (!c.token) {
          sendResponse({ ok: false, error: "Mori token missing - open the extension options" });
          return;
        }
        const r = await fetch(
          `${c.base}/oauth/google/lookup?state=${encodeURIComponent(msg.state || "")}`,
          { headers: { Authorization: `Bearer ${c.token}` } },
        );
        if (!r.ok) {
          sendResponse({ ok: false, error: `lookup failed (${r.status})` });
          return;
        }
        const s = await r.json();
        sendResponse({
          ok: true,
          id: s.id,
          client_data: s.client_data,
          checktoken_url: s.checktoken_url,
        });
        return;
      }

      if (msg && msg.kind === "report") {
        const c = await conf();
        if (!c.token || !msg.id) {
          sendResponse({ ok: false, error: "nothing to report" });
          return;
        }
        await fetch(`${c.base}/oauth/google/${msg.id}/landing`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${c.token}`,
          },
          body: JSON.stringify({
            token: msg.token,
            account_type: msg.account_type || "",
            error: msg.error || "",
          }),
        });
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep the channel open for the async answer
});
