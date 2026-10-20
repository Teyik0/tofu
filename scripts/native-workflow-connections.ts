import { treaty } from "@elysia/eden";
import type { Api } from "../src/api";
import {
  collectNativeErrors,
  createNativeCheck,
  createNativeWait,
  nativeClick,
} from "./native-browser";

export async function connectionsWorkflow(config: { reportUrl: string }) {
  const checks: { name: string; passed: boolean }[] = [];
  const { errors } = collectNativeErrors("all");
  const check = createNativeCheck(checks, null);
  const wait = createNativeWait({ interval: 50, timeout: 15_000 });
  const { api } = treaty<Api>(location.origin, { fetch: { credentials: "include" } });
  try {
    const catalog = await api.desktop.servers.get();
    if (catalog.error) {
      throw catalog.error;
    }
    check(
      "The packaged backend sees the native host catalog",
      catalog.data.local && catalog.data.startLocal && catalog.data.servers.length === 0
    );
    check(
      "Unauthenticated browsers cannot read the native catalog",
      (await api.desktop.servers.get({ fetch: { credentials: "omit" } })).status === 403
    );
    await wait(
      () => document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]') !== null
    );
    nativeClick("Settings");
    await wait(() => document.querySelector('a[href="/options/connections"]') !== null);
    nativeClick(
      document.querySelector<HTMLAnchorElement>(
        'a[href="/options/connections"]'
      ) as HTMLAnchorElement
    );
    await wait(() => document.querySelector("#desktop-servers-title") !== null);
    check(
      "Desktop workspace management is inside Connections",
      document.body.innerText.includes("No remote desktop workspaces saved on this computer.")
    );
    const remoteAccess = document.querySelector<HTMLButtonElement>("#remote-access");
    if (!remoteAccess) {
      throw new Error("Missing remote access control");
    }
    nativeClick(remoteAccess);
    await wait(() => document.querySelector(".connections-transports") !== null);
    nativeClick("Tailscale");
    await wait(() => document.body.innerText.includes("Connect Tofu to Tailscale"));
    nativeClick("Connect Tofu to Tailscale");
    await wait(() => document.body.innerText.includes("Connected · HTTPS not enabled"));
    check(
      "The missing HTTPS prerequisite is visible before Apply",
      document.querySelector('a[href="https://console.tailscale.com/admin/dns"]') !== null &&
        document.body.innerText.includes("Enable HTTPS certificates in Tailscale")
    );
    nativeClick("Cancel setup");
    await wait(() => !document.body.innerText.includes("Cancel setup"));
    // The companion boundary simulates approval while the UI's setup is paused.
    const consent = await api.connections.tailscale.https.post();
    if (consent.error) {
      throw consent.error;
    }
    await api.connections.tailscale.embedded.get();
    await api.connections.tailscale.embedded.get();
    const approved = await api.connections.tailscale.embedded.get();
    const paused = await api.connections.get();
    check(
      "Cancelling setup leaves sharing off after HTTPS approval",
      !approved.error &&
        approved.data.httpsEnabled === true &&
        !(paused.error || paused.data.config.enabled)
    );
    nativeClick("Connect Tofu to Tailscale");
    await wait(() => document.body.innerText.includes("Private HTTPS is ready. Pair a device"));
    const sharing = await api.connections.get();
    check(
      "Connect enables private access automatically after HTTPS authorization",
      !sharing.error &&
        sharing.data.config.enabled &&
        sharing.data.config.tailscaleMode === "embedded" &&
        sharing.data.config.tailscaleOrigin === "https://tofu.tail-test.ts.net"
    );
    nativeClick("Add a server");
    await wait(() => document.querySelector("#desktop-address") !== null);
    check(
      "Pairing uses the normal Connections dialog",
      document
        .querySelector('[role="dialog"]')
        ?.textContent?.includes("Add a desktop workspace") === true
    );
    check(
      "The dialog has no horizontal overflow",
      document.documentElement.scrollWidth === window.innerWidth
    );
    check("Connections renders without runtime errors", errors.length === 0);
    await fetch(config.reportUrl, {
      body: JSON.stringify({ checks, errors, passed: true }),
      method: "POST",
    });
  } catch (error) {
    await fetch(config.reportUrl, {
      body: JSON.stringify({
        checks,
        error: String(error),
        errors,
        page: document.body.innerText,
        passed: false,
      }),
      method: "POST",
    });
  }
}
