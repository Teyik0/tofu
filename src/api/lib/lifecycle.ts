import type { ReadyContext } from "@teyik0/furin-electrobun/host";
import { ElysiaStatus } from "elysia";
import { desktopRuntime } from "../modules/desktop/service";
import { instance } from "./database-plugin";
import { recordLog } from "./diagnostics";
import { resources } from "./runtime";
import { writeServerInfo } from "./server-info";

export async function onReady({ backend }: ReadyContext) {
  const { engine } = await import("../modules/torrents/plugin");
  const { activateExposures, connections } = await import("../modules/connections/plugin");
  // The application port is known now. Exposures forward to it and must be open before Tofu
  // reports ready or opens its window; a failure prevents opening and releases resources.
  connections.listened(Number(new URL(backend.origin).port));
  const activated = await activateExposures();
  if (activated instanceof ElysiaStatus) {
    throw new Error(activated.response.detail);
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
