import { Elysia, ElysiaStatus } from "elysia";
import { version } from "../../../../package.json";
import { databasePlugin, instance, logs } from "../../lib/database-plugin";
import { reserveInitialization } from "../../lib/lifecycle-plugin";
import { TorrentFolders } from "./folders";
import { WorkerTorrentEngine } from "./worker-client";

using _initialization = reserveInitialization();

export const torrentServicePlugin = new Elysia({ name: "tofu-torrent-service" })
  .use(databasePlugin)
  .use(async (app) => {
    await using startup = new AsyncDisposableStack();
    const torrents = await WorkerTorrentEngine.open(
      {
        dataDir: instance.dataDir,
        downloadPath: instance.downloadPath,
        network: { maxConns: 40, userAgent: `Tofu/${version}`, utp: false },
      },
      logs
    );
    startup.defer(torrents.close.bind(torrents));
    torrents.mode = instance.desktop ? "desktop" : "server";

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
      startup.defer(torrentFolders.close.bind(torrentFolders));
      dependencies.resources.use(startup.move());
      return { ...dependencies, torrentFolders, torrents };
    });
  });

await torrentServicePlugin.modules;
