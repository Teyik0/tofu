import { Elysia } from "elysia";
import { version } from "../../../../package.json";
import { instance } from "../../lib/database-plugin";
import { brandIcon } from "./brand";
import { accessPlugin } from "./plugin";

const styles = `
*{box-sizing:border-box}html{color-scheme:light dark}
body{margin:0;min-height:100vh;background:#f5f6f3;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d211b}
main{max-width:465px;margin:0 auto;padding:40px 24px 48px}
h1{margin:0;font-size:24px;letter-spacing:-.7px;font-weight:650;line-height:1.3}
h2{margin:0;font-size:13px;font-weight:600}
p{margin:0}
.brand{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:650;margin-bottom:28px}
.steps{display:flex;align-items:center;gap:8px;margin-bottom:25px;font-size:10px;color:#71786d}
.steps b{color:#3f7d3a}.steps .line{height:1px;flex:1;background:#e2e5df}
.muted{color:#71786d;font-size:12px;margin-top:8px}
.card{padding:14px;background:#fff;border:1px solid #e2e5df;border-radius:10px;margin-top:22px}
.row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.address{font:10px ui-monospace,SFMono-Regular,Menlo,monospace;color:#3c5236;overflow-wrap:anywhere;margin-top:6px}
.divider{height:1px;background:#e2e5df;margin:14px 0}
.badge{display:inline-flex;align-items:center;border:1px solid #dce6d6;background:#edf4ea;color:#33692f;border-radius:5px;padding:3px 6px;font-size:10px;line-height:1.2;white-space:nowrap}
.badge.neutral{background:#f0f2ee;border-color:#e2e5df;color:#71786d}
ul{list-style:none;margin:0;padding:12px 0 0;display:flex;flex-direction:column;gap:9px;font-size:11px}
li{display:flex;gap:8px;align-items:center}li:before{content:"✓";color:#3f7d3a;width:14px;text-align:center}
li.no{color:#899080}li.no:before{content:"✕";color:#899080}
label{display:block;font-size:12px;font-weight:550;margin:18px 0 8px}
input{width:100%;font:inherit;font-size:14px;background:#fff;border:1px solid #d5d9d1;border-radius:7px;padding:10px 12px;color:inherit;min-height:44px}
.note{font-size:10px;color:#71786d;margin-top:7px}
.actions{margin-top:23px;display:flex;flex-direction:column;gap:9px}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;padding:12px;border-radius:7px;border:1px solid #d5d9d1;background:#fff;font:inherit;font-size:12px;font-weight:550;color:inherit;cursor:pointer;text-decoration:none}
button:hover,.button:hover{background:#f0f2ee}
button.primary{background:#3f7d3a;border-color:#3f7d3a;color:#fff}button.primary:hover{background:#356b31}
button:disabled{opacity:.55;cursor:default}
button:focus-visible,input:focus-visible,.button:focus-visible{outline:3px solid #6fa566;outline-offset:3px}
.alert{margin-top:18px;padding:12px;border-radius:8px;border:1px solid #efd4cc;background:#fff8f6;color:#8e3526;font-size:12px}
.alert.info{border-color:#e2e5df;background:#f0f2ee;color:#626b5b}
.footnote{font-size:10px;color:#71786d;margin-top:18px}
.empty{padding:32px 0;text-align:center;display:flex;flex-direction:column;gap:13px;align-items:center}
.empty .icon{width:46px;height:46px;border-radius:13px;background:#edf4ea;display:grid;place-items:center;color:#3f7d3a;font-size:20px}
.empty p{max-width:340px;font-size:12px;color:#71786d}
[hidden]{display:none!important}
@media(prefers-color-scheme:dark){
body{background:#161a14;color:#e6ebe1}.card,input,button,.button{background:#1f241c;border-color:#343b30;color:inherit}
.steps .line,.divider{background:#343b30}.muted,.note,.footnote,.empty p{color:#a3ab9c}.address{color:#b9d39a}
.badge{background:#26351e;border-color:#3b4c32;color:#b9d39a}.badge.neutral{background:#242a21;border-color:#343b30;color:#a3ab9c}
button.primary{background:#4c8f45;border-color:#4c8f45}.alert{background:#2b1d19;border-color:#5a3329;color:#f0b8aa}.alert.info{background:#242a21;border-color:#343b30;color:#c3cbbb}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const pairScript = `
const body = document.body;
const scheme = body.dataset.scheme;
const fragment = new URLSearchParams(location.hash.slice(1));
// Remove the invitation from the address bar and history before anything else can fail.
if (location.hash) history.replaceState(null, "", location.pathname);
// Session storage keeps a pending invitation for a short time, so reloading this page or coming
// back to it still uses the scanned link instead of asking for the code. Only a reload or a
// back navigation restores it; opening the library, pairing or a refusal discards it.
// Storage can be unavailable; pairing then works from memory only.
function forget() {
  try {
    sessionStorage.removeItem("tofu-invitation");
  } catch {}
}
function remember(value, until) {
  try {
    sessionStorage.setItem("tofu-invitation", JSON.stringify({ secret: value, until }));
  } catch {}
}
let stored = null;
try {
  stored = JSON.parse(sessionStorage.getItem("tofu-invitation") || "null");
} catch {}
const restorable = ["reload", "back_forward"].includes(performance.getEntriesByType("navigation")[0]?.type);
const restored = restorable && typeof stored?.secret === "string" && stored.until > Date.now();
const secret = fragment.get("i") || (restored ? stored.secret : undefined);
let until = restored && stored.secret === secret ? stored.until : Date.now() + 15 * 60000;
if (secret) remember(secret, until);
else forget();
const $ = (id) => document.getElementById(id);
const nonce = (() => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
})();
const agent = navigator.userAgent;
const browser = /Edg\\//.test(agent) ? "Edge" : /Firefox\\//.test(agent) ? "Firefox" : /Chrome\\//.test(agent) ? "Chrome" : /Safari\\//.test(agent) ? "Safari" : "Browser";
const system = /iPhone/.test(agent) ? "iPhone" : /iPad/.test(agent) ? "iPad" : /Android/.test(agent) ? "Android" : /Mac OS X/.test(agent) ? "Mac" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "this device";
$("label").value = browser + " on " + system;
// The Tofu app exists only on desktop systems; a phone cannot open the handoff link.
$("open-app").hidden = /iPhone|iPad|Android/.test(agent);
const roles = {
  playback: ["Playback access", ["Browse the library and play videos", "Save progress in your own profile"], ["No downloads, deletion or server settings"]],
  management: ["Management access", ["Browse the library and play videos", "Add, pause and resume downloads"], ["No server settings or device management"]],
  administration: ["Administration access", ["Browse the library and play videos", "Manage downloads, settings and devices"], ["No host folders or apps on the server computer"]],
};
function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
  $("error").focus();
}
async function send(payload) {
  let lastError;
  // Retrying with the same nonce recovers a lost response without creating another device.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("/api/auth/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      return { ok: response.ok, status: response.status, result };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}
function busy(value) {
  for (const button of document.querySelectorAll("button")) button.disabled = value;
  $("form").setAttribute("aria-busy", String(value));
}
async function preview() {
  if (!secret) {
    $("code-field").hidden = false;
    $("open-app").hidden = true;
    $("intro").textContent = "Enter the invitation code you received.";
    return;
  }
  try {
    const { ok, status, result } = await send({ secret, nonce, label: "preview", kind: "browser", preview: true });
    if (!ok) {
      // A used, expired or unknown invitation never becomes valid again.
      if (status === 401 || status === 410) forget();
      showError(result.detail || "This invitation cannot be used.");
      $("continue").disabled = true;
      $("open-app").disabled = true;
      return;
    }
    const [title, allowed, denied] = roles[result.role];
    $("server-name").textContent = result.server.name;
    $("intro").textContent = "You've been invited to connect to " + result.server.name + ".";
    $("role").textContent = title;
    until = Math.min(until, result.expiresAt);
    remember(secret, until);
    const minutes = Math.max(1, Math.round((result.expiresAt - Date.now()) / 60000));
    $("expiry").textContent = "Expires in " + minutes + " min";
    const items = [...allowed, ...(result.canDeleteFiles ? ["Delete downloaded files"] : [])];
    $("grants").replaceChildren(
      ...items.map((text) => Object.assign(document.createElement("li"), { textContent: text })),
      ...denied.map((text) => Object.assign(document.createElement("li"), { className: "no", textContent: text }))
    );
    $("invitation").hidden = false;
  } catch {
    showError("Tofu could not reach this server. Check your connection and reload this page.");
  }
}
$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("error").hidden = true;
  const label = $("label").value.trim();
  const code = $("code").value.trim();
  if (!label) return showError("Enter a name for this device.");
  if (!secret && !code) return showError("Enter the invitation code.");
  busy(true);
  try {
    const { ok, status, result } = await send({ secret, code: secret ? undefined : code, nonce, label, kind: "browser" });
    if (!ok) {
      if (status === 401 || status === 410) forget();
      busy(false);
      return showError(result.detail || "This invitation cannot be used.");
    }
    forget();
    $("status").textContent = "Connected to " + result.server.name + ". Opening the library…";
    location.replace("/");
  } catch {
    busy(false);
    showError("The connection was interrupted. Try again; this invitation is not used twice.");
  }
});
$("open-app").addEventListener("click", () => {
  const target = new URL(scheme + "://pair");
  target.searchParams.set("server", location.origin);
  location.href = target.href + "#i=" + encodeURIComponent(secret);
  $("status").textContent = "If Tofu did not open, install the Tofu app or continue in this browser.";
});
preview();
`;

function digest(value: string) {
  return `'sha256-${new Bun.CryptoHasher("sha256").update(value).digest("base64")}'`;
}

const styleHash = digest(styles);
const pairHash = digest(pairScript);
const headers = (scriptHash?: string) => ({
  "cache-control": "no-store",
  "content-security-policy": [
    "default-src 'none'",
    `style-src ${styleHash}`,
    "img-src data:",
    `script-src ${scriptHash ?? "'none'"}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

const page = (title: string, content: string, script = "", attributes = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body${attributes}><main><div class="brand"><img src="${brandIcon}" width="27" height="27" alt="">Tofu</div>${content}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

const signedOutReasons: { [reason: string]: string } = {
  expired:
    "This browser's access ended or was removed. Downloads on the server continue. To connect again, ask its owner for a new invitation.",
  signed_out:
    "This browser no longer has access. Downloads on the server continue. To connect again, ask its owner for a new invitation.",
};

/**
 * Standalone documents reachable without a session. They are not Furin pages, so no root
 * loader runs and no library data can be hydrated for anonymous visitors.
 */
export const publicDocumentsPlugin = new Elysia({ name: "tofu-public-documents" })
  .use(accessPlugin)
  .get("/.well-known/tofu", { public: true }, ({ access, set }) => {
    set.headers["cache-control"] = "no-store";
    return access.descriptor(version);
  })
  .get(
    "/pair",
    { public: true },
    () =>
      new Response(
        page(
          "Connect to a Tofu server",
          `<div class="steps"><b>1. Invitation</b><span class="line"></span><span>2. Open your library</span></div>
<h1>A library, within reach.</h1><p class="muted" id="intro">Checking your invitation…</p>
<form id="form" novalidate>
<section class="card" id="invitation" hidden aria-labelledby="server-name">
<div class="row"><h2 id="server-name"></h2><span class="badge">Secure link</span></div>
<div class="divider"></div>
<div class="row"><h2 id="role"></h2><span class="badge neutral" id="expiry"></span></div>
<ul id="grants"></ul></section>
<div id="code-field" hidden><label for="code">Invitation code</label><input id="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCDE-FGHJK"></div>
<label for="label">Name this device</label><input id="label" maxlength="64" autocomplete="off" aria-describedby="label-note">
<p class="note" id="label-note">Shown to the server owner in Authorized devices.</p>
<div class="alert" id="error" role="alert" tabindex="-1" hidden></div>
<div class="actions"><button class="primary" id="continue" type="submit">Continue in this browser</button>
<button id="open-app" type="button">Open in Tofu</button></div>
<p class="note" id="status" role="status" aria-live="polite"></p></form>
<p class="footnote">This invitation works once. Choose where you want to use it. Your playback does not update the owner's AniList account.</p>`,
          pairScript,
          ` data-scheme="${instance.profile === "release" ? "tofu" : "tofu-dev"}"`
        ),
        { headers: headers(pairHash) }
      )
  )
  .get(
    "/signed-out",
    { public: true },
    ({ query }) =>
      new Response(
        page(
          "Signed out — Tofu",
          `<div class="empty"><span class="icon" aria-hidden="true">🔒</span><h1>You're signed out</h1><p>${
            signedOutReasons[String(query.reason)] ?? signedOutReasons.signed_out
          }</p><a class="button" href="/pair">Use an invitation code</a></div>`
        ),
        { headers: headers() }
      )
  );
