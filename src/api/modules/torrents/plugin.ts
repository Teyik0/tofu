import { Context } from "effect";
import { Elysia } from "elysia";
import { services, servicesRuntime } from "../../lib/services-runtime";
import { TorrentFolders } from "./folders";
import { TorrentClient } from "./layer";

export const torrents = Context.get(services, TorrentClient);

export const torrentServicePlugin = new Elysia({ name: "tofu-torrent-service" }).decorate({
  torrentFolders: Context.get(services, TorrentFolders),
  torrentFoldersRuntime: servicesRuntime,
  torrents,
});
