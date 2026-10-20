import "@teyik0/furin/server-only";
import { join } from "node:path";
import { ElysiaStatus, problem } from "elysia";
import { db, instance } from "../../lib/database-plugin";
import { recordLog } from "../../lib/diagnostics";
import { resources, runtime } from "../../lib/runtime";
import { EmbeddedTailscale } from "./embedded";
import { ConnectionsService } from "./service";

/** Exit status asking a supervisor (systemd, Docker, launchd) to start the server again. */
export const RESTART_EXIT_CODE = 75;
const defaultPort = instance.profile === "dev" ? 3030 : 3031;

export const connections = new ConnectionsService({
  dataDir: instance.dataDir,
  db,
  defaultPort: process.env.TOFU_PORT === undefined ? defaultPort : instance.port,
  fixedPort: instance.desktop ? null : instance.port,
  now: Date.now,
  restart() {
    if (runtime.current.kind === "desktop") {
      const { desktop } = runtime.current;
      const restart = async () => {
        try {
          await desktop.restart();
        } catch (error) {
          recordLog({ component: "connections", error, level: "error", operation: "restart" });
        }
      };
      void restart();
      return;
    }
    // One listener cannot change scheme or interface in place; a supervisor restarts the server.
    process.exitCode = RESTART_EXIT_CODE;
    process.kill(process.pid, "SIGTERM");
  },
});

export const embeddedTailscale = resources.use(
  new EmbeddedTailscale(join(instance.dataDir, "tailscale"))
);

// Previously enabled transport is a startup dependency. Validate enrollment before apiPlugin
// can listen; opening the TLS forwarding listener waits until the application port is known.
const configuredTransport = connections.config();
if (
  configuredTransport.enabled &&
  configuredTransport.transport === "tailscale" &&
  configuredTransport.tailscaleMode === "embedded"
) {
  const started = await embeddedTailscale.request({ hostname: "tofu", method: "start" });
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
    if (status.origin && status.origin !== configuredTransport.tailscaleOrigin) {
      throw new Error("The embedded Tailscale identity changed. Review it on the host");
    }
    if (status.state === "Running" && status.origin === configuredTransport.tailscaleOrigin) {
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

/** Restores an already authorized embedded node; startup never starts an enrollment flow. */
export async function restoreEmbeddedTransport(port: number) {
  const config = connections.config();
  if (!config.enabled || config.transport !== "tailscale" || config.tailscaleMode !== "embedded") {
    return;
  }
  const started = await embeddedTailscale.request({ hostname: "tofu", method: "start" });
  if (started instanceof ElysiaStatus) {
    return started;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each iteration depends on the previous lifecycle or readiness result.
    const status = await embeddedTailscale.request({ method: "serve", port });
    if (status instanceof ElysiaStatus) {
      return status;
    }
    if (status.state === "ready" && status.origin === config.tailscaleOrigin) {
      return;
    }
    if (status.origin && status.origin !== config.tailscaleOrigin) {
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
