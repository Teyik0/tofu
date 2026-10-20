import "@teyik0/furin/server-only";
import { ElysiaStatus, problem } from "elysia";
import { hostTrust, localCertificate } from "./certificates";
import type { ConnectionsUpdate } from "./model";
import { connections, embeddedTailscale } from "./plugin";
import type { RemoteAccessConfig } from "./service";
import { disableTailscale, enableTailscale } from "./tailscale";

/** A browser-facing HTTPS origin without credentials, path, query or fragment. */
function httpsOrigin(value: string) {
  const url = URL.parse(value);
  if (
    url?.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.origin;
}

/**
 * Validates and applies a remote access change: prerequisites of the chosen transport, the
 * Tailscale mapping Tofu owns, and the confirm-or-revert journal. Owner-only fields (trusted
 * proxies, certificate names) are refused for other callers.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validation, transport state and cleanup form one lifecycle operation.
export async function updateRemoteAccess(body: ConnectionsUpdate, owner: boolean) {
  const current = connections.config();
  if (connections.listening().pendingConfirmation) {
    return problem(409, { detail: "Confirm the previous connection change first" });
  }
  const proxyOrigin = body.proxyOrigin ? httpsOrigin(body.proxyOrigin) : null;
  if (body.proxyOrigin && !proxyOrigin) {
    return problem(400, { detail: "Enter an HTTPS address such as https://tofu.example.com" });
  }
  if (body.enabled && body.transport === "proxy" && !proxyOrigin) {
    return problem(400, { detail: "Enter the HTTPS address of your reverse proxy" });
  }
  const trustedProxies = body.trustedProxies ?? current.trustedProxies;
  if (
    !owner &&
    (trustedProxies.join() !== current.trustedProxies.join() ||
      (body.lanHostnames ?? current.lanHostnames).join() !== current.lanHostnames.join())
  ) {
    return problem(403, {
      detail: "Trusted proxies and certificates are set on the server itself",
    });
  }
  if (body.enabled && body.transport === "lan") {
    const certificate = localCertificate();
    if (!certificate || certificate.expiresAt <= Date.now()) {
      return problem(409, {
        detail: "Create a valid local network certificate on the server first",
      });
    }
    const trust = await hostTrust();
    if (!trust.trusted) {
      return problem(409, { detail: trust.detail });
    }
  }
  let { tailscaleOrigin } = current;
  let tailscaleServeOwned = current.tailscaleServeOwned ?? false;
  const port = connections.servicePort(current);
  if (body.enabled && body.transport === "tailscale" && body.tailscaleMode === "embedded") {
    const status = await embeddedTailscale.request({ method: "serve", port });
    if (status instanceof ElysiaStatus) {
      return status;
    }
    if (status.state === "https-disabled") {
      return problem(409, {
        detail:
          "Tofu is connected to Tailscale, but HTTPS certificates are disabled. Open Tailscale admin → DNS → HTTPS Certificates → Enable HTTPS, then check the connection and apply again",
      });
    }
    if (status.state !== "ready" || !status.origin) {
      return problem(409, {
        detail: "Connect Tofu to Tailscale and enable HTTPS in your tailnet first",
      });
    }
    tailscaleOrigin = status.origin;
  } else if (body.enabled && body.transport === "tailscale") {
    const status = await enableTailscale(port);
    if (status.state !== "ready") {
      return problem(409, {
        detail:
          "detail" in status
            ? status.detail
            : "Tailscale is not ready. Check Tailscale and follow its next step",
      });
    }
    tailscaleOrigin = status.origin;
    tailscaleServeOwned ||= status.created === true;
  }
  if (
    current.enabled &&
    current.transport === "tailscale" &&
    (!body.enabled ||
      body.transport !== "tailscale" ||
      body.tailscaleMode !== current.tailscaleMode)
  ) {
    if (current.tailscaleMode === "embedded") {
      const stopped = await embeddedTailscale.request({ method: "stop" });
      if (stopped instanceof ElysiaStatus) {
        return stopped;
      }
    } else if (current.tailscaleServeOwned) {
      // Both the creation record and the current mapping must match before removal.
      await disableTailscale(port);
      tailscaleServeOwned = false;
    }
  }
  const next: RemoteAccessConfig = {
    ...current,
    enabled: body.enabled,
    lanHostnames: body.lanHostnames ?? current.lanHostnames,
    proxyOrigin: proxyOrigin ?? (body.proxyOrigin === null ? null : current.proxyOrigin),
    tailscaleMode: body.tailscaleMode ?? "system",
    tailscaleOrigin,
    tailscaleServeOwned,
    transport: body.transport,
    trustedProxies,
  };
  const applied = connections.apply(next, owner);
  if (applied instanceof ElysiaStatus) {
    return applied;
  }
  return { applied, previous: current };
}
