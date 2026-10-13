import type { ReadyContext } from "@teyik0/furin-electrobun/host";
import { desktopRuntime } from "../modules/desktop/service";
import { resources } from "./runtime";
import { writeServerInfo } from "./server-info";

export async function onReady({ backend }: ReadyContext) {
  const [{ instance }, { engine }] = await Promise.all([
    import("./database-plugin"),
    import("../modules/torrents/plugin"),
  ]);
  await writeServerInfo(instance, engine, backend.origin, backend.cookie);
}
export async function onShutdown() {
  try {
    await resources.disposeAsync();
  } finally {
    desktopRuntime.engine = undefined;
  }
}
