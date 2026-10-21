import type { ReadyContext } from "@teyik0/furin-electrobun/host";
import { ElysiaStatus } from "elysia";
import { createLogger, initLogger } from "evlog";
import { desktopRuntime } from "../modules/desktop/service";
import { db, instance, lease, logs } from "./database-plugin";
import { loggerConfig } from "./diagnostics";
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

let shutdown: Promise<void> | undefined;

/** Stop producers before their dependencies, including after a partially failed startup. */
export function stopServices() {
  if (shutdown) {
    return shutdown;
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Explicit teardown continues after failures and preserves dependency order during partial startup.
  shutdown = (async () => {
    const [anilist, automation, discovery, jev, plugins, torrents, updates, connections] =
      await Promise.allSettled([
        import("../modules/anilist/plugin"),
        import("../modules/automation/plugin"),
        import("../modules/discovery/plugin"),
        import("../modules/jev/plugin"),
        import("../modules/plugins/plugin"),
        import("../modules/torrents/plugin"),
        import("../modules/updates/plugin"),
        import("../modules/connections/plugin"),
      ]);
    const anilistService = anilist.status === "fulfilled" ? anilist.value.anilist : undefined;
    const automationService =
      automation.status === "fulfilled" ? automation.value.releaseAutomation : undefined;
    const discoveryService =
      discovery.status === "fulfilled" ? discovery.value.discovery : undefined;
    const jevService = jev.status === "fulfilled" ? jev.value.jev : undefined;
    const pluginsService = plugins.status === "fulfilled" ? plugins.value.plugins : undefined;
    const torrentServices = torrents.status === "fulfilled" ? torrents.value : undefined;
    const updatesService = updates.status === "fulfilled" ? updates.value.updates : undefined;
    const network = connections.status === "fulfilled" ? connections.value : undefined;
    const errors: unknown[] = [];
    initLogger({ ...loggerConfig, drain: logs });
    const log = createLogger({
      component: "application",
      dataDir: instance.dataDir,
      operation: "shutdown",
    });
    log.emit();
    try {
      updatesService?.close();
    } catch (error) {
      errors.push(error);
    }
    const outcomes = [
      ...(await Promise.allSettled([
        anilistService?.close(),
        torrentServices?.torrentFolders.close(),
      ])),
      ...(await Promise.allSettled([automationService?.close()])),
      ...(await Promise.allSettled([discoveryService?.close()])),
      ...(await Promise.allSettled([jevService?.close(), torrentServices?.engine.close()])),
      ...(await Promise.allSettled([network?.closeLan()])),
      ...(await Promise.allSettled([network?.embeddedTailscale[Symbol.asyncDispose]()])),
    ];
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        errors.push(outcome.reason);
      } else if (outcome.value instanceof ElysiaStatus) {
        errors.push(new Error(outcome.value.response.detail));
      }
    }
    try {
      pluginsService?.close();
    } catch (error) {
      errors.push(error);
    }
    desktopRuntime.engine = undefined;
    try {
      db.$client.close(true);
    } catch (error) {
      errors.push(error);
    }
    try {
      await logs.flush();
    } catch (error) {
      errors.push(error);
    }
    try {
      await lease.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Tofu could not stop every application service");
    }
  })();
  return shutdown;
}
