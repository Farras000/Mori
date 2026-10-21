// Mori login helper - options page.

const DEFAULTS = { base: "http://127.0.0.1:3000", token: "" };

const baseEl = document.getElementById("base");
const tokenEl = document.getElementById("token");
const statusEl = document.getElementById("status");

function say(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || "";
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  baseEl.value = stored.base || DEFAULTS.base;
  tokenEl.value = stored.token || "";
});

document.getElementById("save").addEventListener("click", async () => {
  const base = (baseEl.value || DEFAULTS.base).replace(/\/+$/, "");
  const token = (tokenEl.value || "").trim();
  await chrome.storage.sync.set({ base, token });
  say("Saved. Open the Growtopia Google login from Mori; the result comes back automatically.", "ok");
});

// Optional self-test: ask the backend for its browser status.
document.addEventListener("DOMContentLoaded", () => {
  const probe = document.createElement("button");
  probe.textContent = "Test connection";
  probe.style.marginLeft = "8px";
  probe.addEventListener("click", async () => {
    try {
      const { base, token } = await chrome.storage.sync.get(DEFAULTS);
      const res = await fetch(`${(base || DEFAULTS.base).replace(/\/+$/, "")}/oauth/browser/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      say(res.ok ? "Backend reachable." : `Backend returned ${res.status}.`, res.ok ? "ok" : "err");
    } catch (e) {
      say(String(e), "err");
    }
  });
  document.getElementById("save").after(probe);
});
