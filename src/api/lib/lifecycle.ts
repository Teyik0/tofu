import type { ReadyContext } from "@teyik0/furin-electrobun/host";
import { ElysiaStatus } from "elysia";
import { desktopRuntime } from "../modules/desktop/service";
import { instance } from "./database-plugin";
import { recordLog } from "./diagnostics";
import { resources } from "./runtime";
import { writeServerInfo } from "./server-info";

export async function onReady({ backend }: ReadyContext) {
  const { engine } = await import("../modules/torrents/plugin");
  const { connections, restoreEmbeddedTransport } = await import("../modules/connections/plugin");
  const origin = new URL(backend.origin);
  connections.ready({
    hostname: connections.listenOptions().hostname,
    port: Number(origin.port),
    tls: origin.protocol === "https:",
  });
  const restored = await restoreEmbeddedTransport(Number(origin.port));
  if (restored instanceof ElysiaStatus) {
    throw new Error(restored.response.detail);
  }
  const config = connections.config();
  const discoveryCLI = process.platform === "darwin" ? Bun.which("dns-sd") : null;
  if (
    process.env.TOFU_DISCOVERY !== "0" &&
    config.enabled &&
    config.transport === "lan" &&
    discoveryCLI
  ) {
    const identity = (await import("../modules/access/plugin")).access.identity();
    const advertisement = Bun.spawn(
      [
        discoveryCLI,
        "-R",
        identity.name,
        "_tofu._tcp",
        "local",
        String(origin.port),
        `serverId=${identity.serverId}`,
        "protocol=1",
      ],
      { stderr: "ignore", stdout: "ignore" }
    );
    resources.defer(async () => {
      if (advertisement.exitCode === null) {
        advertisement.kill();
      }
      await advertisement.exited;
    });
  }
  await writeServerInfo(instance, engine, backend.origin, backend.cookie);
}
export async function onShutdown() {
  recordLog({
    component: "application",
    dataDir: instance.dataDir,
    level: "info",
    operation: "shutdown",
  });
  try {
    await resources.disposeAsync();
  } finally {
    desktopRuntime.engine = undefined;
  }
}
