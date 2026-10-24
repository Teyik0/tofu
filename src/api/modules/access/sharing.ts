import "@teyik0/furin/server-only";
import { ElysiaStatus, problem } from "elysia";
import { tailscale } from "../../lib/tailscale";
import { closeLan, lanNames, openLan } from "../../lib/tailscale/lan";
import { checkTailscale, disableTailscale, enableTailscale } from "../../lib/tailscale/system";
import type { ConnectionsUpdate } from "./model";
import type { AccessService, SharingConfig } from "./service";

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
 * Validates and applies a change to one exposure (`transport`); the others keep their state.
 * Changes run one at a time: each is prepared, journaled, activated, then saved, and a failed
 * activation restores the exposure's previous forwarding. Owner-only fields (trusted proxies,
 * certificate names) are refused for other callers.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validation, activation and rollback of one exposure form one lifecycle operation.
export async function updateRemoteAccess(
  access: AccessService,
  body: ConnectionsUpdate,
  owner: boolean
) {
  const turn = access.reserve();
  try {
    await turn.previous;
    const current = access.sharing;
    const exposure = body.transport;
    const proxyOrigin = body.proxyOrigin ? httpsOrigin(body.proxyOrigin) : null;
    if (body.proxyOrigin && !proxyOrigin) {
      return problem(400, { detail: "Enter an HTTPS address such as https://tofu.example.com" });
    }
    if (exposure !== "lan" && (body.lanPort !== undefined || body.lanHostnames !== undefined)) {
      return problem(400, {
        detail: "Change local network settings together with the local network connection",
      });
    }
    const trustedProxies = body.trustedProxies ?? current.proxy.trustedProxies;
    const hostnames = body.lanHostnames ?? current.lan.hostnames;
    if (
      !owner &&
      (trustedProxies.join() !== current.proxy.trustedProxies.join() ||
        hostnames.join() !== current.lan.hostnames.join())
    ) {
      return problem(403, {
        detail: "Trusted proxies and certificates are set on the server itself",
      });
    }
    const lanPort = body.lanPort ?? current.lan.port;
    const { port } = access;
    if (lanPort === port) {
      return problem(400, {
        detail: `Choose a local network port other than ${port}, which Tofu uses on this computer`,
      });
    }
    const next: SharingConfig = {
      ...current,
      lan: {
        enabled: exposure === "lan" ? body.enabled : current.lan.enabled,
        hostnames,
        port: lanPort,
      },
      proxy: {
        enabled: exposure === "proxy" ? body.enabled : current.proxy.enabled,
        origin: proxyOrigin ?? (body.proxyOrigin === null ? null : current.proxy.origin),
        trustedProxies,
      },
      tailscale:
        exposure === "tailscale"
          ? {
              ...current.tailscale,
              enabled: body.enabled,
              // Enabling without a mode uses the system installation; turning off keeps the mode.
              mode: body.tailscaleMode ?? (body.enabled ? "system" : current.tailscale.mode),
            }
          : current.tailscale,
    };
    if (next.proxy.enabled && !next.proxy.origin) {
      return problem(400, { detail: "Enter the HTTPS address of your reverse proxy" });
    }
    const tailscaleChanged =
      current.tailscale.enabled !== next.tailscale.enabled ||
      (next.tailscale.enabled && current.tailscale.mode !== next.tailscale.mode);
    const lanChanged =
      current.lan.enabled !== next.lan.enabled ||
      (next.lan.enabled &&
        (current.lan.port !== next.lan.port ||
          current.lan.hostnames.join() !== next.lan.hostnames.join()));

    // Prepare: verify prerequisites without changing any forwarding.
    if (lanChanged && next.lan.enabled) {
      const names = lanNames(next);
      if (names instanceof ElysiaStatus) {
        return names;
      }
      if (!tailscale.binary) {
        return problem(503, {
          detail: "The native network component is missing. Rebuild or reinstall Tofu",
        });
      }
    }
    let serveIntent = false;
    if (tailscaleChanged && next.tailscale.enabled && next.tailscale.mode === "system") {
      const status = await checkTailscale(port);
      if (status.state !== "available" && status.state !== "ready") {
        return problem(409, {
          detail:
            "detail" in status
              ? status.detail
              : "Tailscale is not ready. Check Tailscale and follow its next step",
        });
      }
      serveIntent = status.state === "available";
    }

    // Journal, then activate. An interrupted change never widens access after a restart.
    access.journal(next, serveIntent);
    if (lanChanged && next.lan.enabled) {
      const opened = await openLan(access, next, port);
      if (opened instanceof ElysiaStatus) {
        if (current.lan.enabled) {
          // Restore the previous local network ingress; its address and port stay in use.
          const restored = await openLan(access, current, port);
          if (restored instanceof ElysiaStatus) {
            return restored;
          }
        }
        access.abandon();
        return opened;
      }
    }
    if (tailscaleChanged && next.tailscale.enabled && next.tailscale.mode === "embedded") {
      const started = await tailscale.start();
      if (started instanceof ElysiaStatus) {
        access.abandon();
        return started;
      }
      const status = await tailscale.request({ method: "serve", port });
      if (status instanceof ElysiaStatus) {
        access.abandon();
        return status;
      }
      if (status.state !== "ready" || !status.origin) {
        access.abandon();
        return problem(409, {
          detail:
            status.state === "https-disabled"
              ? "Tofu is connected to Tailscale, but HTTPS certificates are disabled. Open Tailscale admin → DNS → HTTPS Certificates → Enable HTTPS, then check the connection and apply again"
              : "Connect Tofu to Tailscale and enable HTTPS in your tailnet first",
        });
      }
      next.tailscale = { ...next.tailscale, origin: status.origin };
      access.opened("tailscale");
    } else if (tailscaleChanged && next.tailscale.enabled) {
      const status = await enableTailscale(port);
      if (status.state !== "ready") {
        access.abandon();
        return problem(409, {
          detail:
            "detail" in status
              ? status.detail
              : "Tailscale is not ready. Check Tailscale and follow its next step",
        });
      }
      next.tailscale = {
        ...next.tailscale,
        origin: status.origin,
        serveOwned: next.tailscale.serveOwned || status.created === true,
      };
    }
    if (
      current.tailscale.enabled &&
      current.tailscale.mode === "embedded" &&
      (!next.tailscale.enabled || next.tailscale.mode !== "embedded")
    ) {
      const stopped = await tailscale.request({ method: "stop" });
      if (stopped instanceof ElysiaStatus) {
        access.abandon();
        return stopped;
      }
    }
    if (lanChanged && !next.lan.enabled) {
      const closed = await closeLan(access);
      if (closed instanceof ElysiaStatus) {
        access.abandon();
        return closed;
      }
    }
    const saved = access.save(next);
    // A system Serve mapping Tofu created and no longer uses is removed after the configuration
    // stops accepting its address; if Tailscale is unreachable, startup retries.
    if (
      saved.tailscale.serveOwned &&
      !(saved.tailscale.enabled && saved.tailscale.mode === "system")
    ) {
      const removed = await disableTailscale(port);
      if (removed.state === "available" || removed.state === "conflict") {
        access.save({ ...saved, tailscale: { ...saved.tailscale, serveOwned: false } });
      }
    }
    return { config: access.sharing, previous: current };
  } finally {
    turn.release();
  }
}
