import { Elysia } from "elysia";
import { version } from "../../../../package.json";
import { databasePlugin, instance, logs } from "../../lib/database-plugin";
import { resources } from "../../lib/runtime";
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
await engine.assertReady();

export const torrentServicePlugin = new Elysia({ name: "tofu-torrent-service" })
  .use(databasePlugin)
  .decorate("torrents", engine);
