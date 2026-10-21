import { Elysia, ElysiaStatus } from "elysia";
import { version } from "../../../../package.json";
import { databasePlugin, instance, logs } from "../../lib/database-plugin";
import { TorrentFolders } from "./folders";
import { WorkerTorrentEngine } from "./worker-client";

export const torrentServicePlugin = new Elysia({ name: "tofu-torrent-service" })
  .use(databasePlugin)
  .use(async (app) => {
    const torrents = await WorkerTorrentEngine.open(
      {
        dataDir: instance.dataDir,
        downloadPath: instance.downloadPath,
        network: { maxConns: 40, userAgent: `Tofu/${version}`, utp: false },
      },
      logs
    );
    torrents.mode = instance.desktop ? "desktop" : "server";

    try {
      const ready = await torrents.assertReady();
      if (ready instanceof ElysiaStatus) {
        throw new Error(ready.response.detail);
      }

      return app.decorate((dependencies) => {
        const torrentFolders = new TorrentFolders({
          dataDir: instance.dataDir,
          db: dependencies.db,
          engine: torrents,
        });

        return { ...dependencies, torrentFolders, torrents };
      });
    } catch (error) {
      try {
        await torrents.close();
      } catch (cleanupError) {
        // biome-ignore lint/style/useErrorCause: AggregateError preserves both failures and keeps startup as the primary cause.
        throw new AggregateError(
          [error, cleanupError],
          "Tofu could not initialize its torrent services",
          { cause: error }
        );
      }
      throw error;
    }
  });

await torrentServicePlugin.modules;
