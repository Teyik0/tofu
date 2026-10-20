import { Elysia, ElysiaStatus } from "elysia";
import { version } from "../../../../package.json";
import { databasePlugin, db, instance, logs } from "../../lib/database-plugin";
import { resources } from "../../lib/runtime";
import { TorrentFolders } from "./folders";
import { WorkerTorrentEngine } from "./worker-client";

export const engine = await WorkerTorrentEngine.open(
  {
    dataDir: instance.dataDir,
    downloadPath: instance.downloadPath,
    network: { maxConns: 40, userAgent: `Tofu/${version}`, utp: false },
  },
  logs
);
resources.defer(engine.close.bind(engine));
engine.mode = instance.desktop ? "desktop" : "server";
const ready = await engine.assertReady();
if (ready instanceof ElysiaStatus) {
  await resources.disposeAsync();
  throw new Error(ready.response.detail);
}
export const torrentFolders = new TorrentFolders({ dataDir: instance.dataDir, db, engine });
resources.defer(torrentFolders.close.bind(torrentFolders));

export const torrentServicePlugin = new Elysia({ name: "tofu-torrent-service" })
  .use(databasePlugin)
  .decorate("torrents", engine)
  .decorate("torrentFolders", torrentFolders);
