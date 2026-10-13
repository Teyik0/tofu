import type { ReadyContext } from "@teyik0/furin-electrobun/host";
import { desktopRuntime } from "../modules/desktop/service";
import { instance } from "./database-plugin";
import { recordLog } from "./diagnostics";
import { resources } from "./runtime";
import { writeServerInfo } from "./server-info";

export async function onReady({ backend }: ReadyContext) {
  const { engine } = await import("../modules/torrents/plugin");
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
