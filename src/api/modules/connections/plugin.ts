import "@teyik0/furin/server-only";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ElysiaStatus, problem } from "elysia";
import { serverIdentity } from "../../../db/schema";
import { db, instance } from "../../lib/database-plugin";
import { resources } from "../../lib/runtime";
import { EmbeddedTailscale } from "./embedded";
import { ConnectionsService, type RemoteAccessConfig } from "./service";
import { disableTailscale } from "./tailscale";

const defaultPort = instance.profile === "dev" ? 3030 : 3031;

export const connections = new ConnectionsService({
  dataDir: instance.dataDir,
  db,
  defaultLanPort: instance.profile === "dev" ? 3442 : 3443,
  defaultPort: process.env.TOFU_PORT === undefined ? defaultPort : instance.port,
  fixedPort: instance.desktop ? null : instance.port,
  now: Date.now,
});

export const embeddedTailscale = resources.use(
  new EmbeddedTailscale(join(instance.dataDir, "tailscale"), join(instance.dataDir, "tls"))
);

/** Bonjour advertisement of the local network ingress (macOS `dns-sd`), while it is open. */
let advertisement: ReturnType<typeof Bun.spawn<"ignore", "ignore", "ignore">> | null = null;
resources.defer(async () => {
  const running = advertisement;
  advertisement = null;
  if (running && running.exitCode === null) {
    running.kill();
    await running.exited;
  }
});

const configured = connections.config();
// A system Serve mapping that Tofu created but no longer uses is removed, and only while it is
// still exactly Tofu's mapping. Interrupted changes leave this to startup.
if (
  configured.tailscale.serveOwned &&
  !(configured.tailscale.enabled && configured.tailscale.mode === "system")
) {
  const removed = await disableTailscale(configured.port);
  if (removed.state === "available" || removed.state === "conflict") {
    connections.save({ ...configured, tailscale: { ...configured.tailscale, serveOwned: false } });
  }
}

// Enabled exposures are startup dependencies. Validate them before apiPlugin can listen;
// forwarding opens once the application port is known (`activateExposures`).
if (configured.lan.enabled) {
  const names = connections.lanNames(configured);
  if (names instanceof ElysiaStatus) {
    throw new Error(names.response.detail);
  }
  if (!embeddedTailscale.available()) {
    throw new Error("The native network component is missing. Rebuild or reinstall Tofu");
  }
}
// Restarts reuse the device name chosen at enrollment; another name would rename the node.
const tailscaleName = `tofu-${db.select().from(serverIdentity).where(eq(serverIdentity.key, "server")).get()?.serverId.slice(0, 8)}`;
if (configured.tailscale.enabled && configured.tailscale.mode === "embedded") {
  const started = await embeddedTailscale.request({ hostname: tailscaleName, method: "start" });
  if (started instanceof ElysiaStatus) {
    throw new Error(started.response.detail);
  }
  let enrolled = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Enrollment must be validated before opening the application listener.
    const status = await embeddedTailscale.request({ method: "status" });
    if (status instanceof ElysiaStatus) {
      throw new Error(status.response.detail);
    }
    if (status.authUrl) {
      throw new Error("The embedded Tailscale login expired. Reconnect it on the host");
    }
    if (status.origin && status.origin !== configured.tailscale.origin) {
      throw new Error("The embedded Tailscale identity changed. Review it on the host");
    }
    if (status.state === "Running" && status.origin === configured.tailscale.origin) {
      enrolled = true;
      break;
    }
    await Bun.sleep(250);
  }
  if (!enrolled) {
    throw new Error(
      "The embedded private network is unavailable. Recover the connection on the host"
    );
  }
}

/**
 * Opens the local network HTTPS ingress for `config`, replacing the previous one, and advertises
 * its public port. Only names and addresses the certificate covers are forwarded, always to the
 * loopback application port.
 */
export async function openLan(config: RemoteAccessConfig) {
  const previous = advertisement;
  advertisement = null;
  if (previous && previous.exitCode === null) {
    previous.kill();
    await previous.exited;
  }
  const names = connections.lanNames(config);
  if (names instanceof ElysiaStatus) {
    connections.closed("lan", names.response.detail);
    return names;
  }
  const opened = await embeddedTailscale.request({
    hosts: names,
    lanPort: config.lan.port,
    method: "lan-open",
    port: connections.servicePort(),
  });
  if (opened instanceof ElysiaStatus) {
    connections.closed("lan", opened.response.detail);
    return opened;
  }
  connections.opened("lan", opened.hosts ?? []);
  const discovery = process.platform === "darwin" ? Bun.which("dns-sd") : null;
  const identity = db.select().from(serverIdentity).where(eq(serverIdentity.key, "server")).get();
  if (process.env.TOFU_DISCOVERY !== "0" && discovery && identity) {
    advertisement = Bun.spawn(
      [
        discovery,
        "-R",
        identity.name,
        "_tofu._tcp",
        "local",
        String(config.lan.port),
        `serverId=${identity.serverId}`,
        "protocol=1",
      ],
      { stderr: "ignore", stdin: "ignore", stdout: "ignore" }
    );
  }
  return opened;
}

/** Closes the local network ingress and its advertisement; the private network is unaffected. */
export async function closeLan() {
  connections.closed("lan");
  const previous = advertisement;
  advertisement = null;
  if (previous && previous.exitCode === null) {
    previous.kill();
    await previous.exited;
  }
  if (!embeddedTailscale.running()) {
    return;
  }
  return await embeddedTailscale.request({ method: "lan-close" });
}

/**
 * Opens every enabled exposure that forwards through the companion once the application port is
 * known. Startup waits for this before Tofu opens or reports ready; a failure prevents opening.
 * Startup never begins an enrollment flow: only an authorized embedded node is restored.
 */
export async function activateExposures() {
  const config = connections.config();
  if (config.lan.enabled) {
    const opened = await openLan(config);
    if (opened instanceof ElysiaStatus) {
      return opened;
    }
  }
  if (!config.tailscale.enabled || config.tailscale.mode !== "embedded") {
    return;
  }
  const started = await embeddedTailscale.request({ hostname: tailscaleName, method: "start" });
  if (started instanceof ElysiaStatus) {
    return started;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each iteration depends on the previous lifecycle or readiness result.
    const status = await embeddedTailscale.request({
      method: "serve",
      port: connections.servicePort(),
    });
    if (status instanceof ElysiaStatus) {
      return status;
    }
    if (status.state === "ready" && status.origin === config.tailscale.origin) {
      connections.opened("tailscale");
      return;
    }
    if (status.origin && status.origin !== config.tailscale.origin) {
      return problem(409, {
        detail: "The embedded Tailscale node identity changed. Review remote access on the host",
      });
    }
    if (status.authUrl) {
      return problem(409, {
        detail: "The embedded Tailscale login expired. Reconnect it on the host",
      });
    }
    await Bun.sleep(250);
  }
  return problem(503, {
    detail: "The embedded private network is not ready. Check its enrollment on the host",
  });
}
