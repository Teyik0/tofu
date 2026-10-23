import type { DesktopContext } from "@teyik0/furin-electrobun/host";
import { problem } from "elysia";
import type { InstanceProfile } from "../../lib/instance";

type Associations = Pick<DesktopContext, "associations">;

export async function setDefaultTorrentFileApp(profile: InstanceProfile, desktop: Associations) {
  if (profile !== "release") {
    return problem(409, {
      detail: "Use the installed release of Tofu to change default applications",
    });
  }
  const target = { extension: "torrent", mimeType: "application/x-bittorrent" };
  const requested = await desktop.associations.requestDefault(target);
  if (requested.status !== "confirmed") {
    return problem(409, {
      detail: "Choose Tofu for .torrent files in your system's default application settings",
    });
  }
  const confirmed = await desktop.associations.read(target);
  if (
    confirmed.status !== "confirmed" ||
    !requested.application ||
    confirmed.application !== requested.application
  ) {
    return problem(409, {
      detail:
        "The system did not confirm Tofu as the default for .torrent files. Move Tofu to Applications and try again.",
    });
  }
  return { torrent: confirmed.application };
}

export async function readTorrentDefaults(desktop: Associations) {
  const [magnet, torrent] = await Promise.all([
    desktop.associations.read({ scheme: "magnet" }),
    desktop.associations.read({ extension: "torrent", mimeType: "application/x-bittorrent" }),
  ]);
  return {
    magnet: magnet.status === "confirmed" ? magnet.application : null,
    torrent: torrent.status === "confirmed" ? torrent.application : null,
  };
}

export async function setDefaultTorrentApp(profile: InstanceProfile, desktop: Associations) {
  if (profile !== "release") {
    return problem(409, {
      detail: "Use the installed release of Tofu to change default applications",
    });
  }
  const torrent = await desktop.associations.requestDefault({
    extension: "torrent",
    mimeType: "application/x-bittorrent",
  });
  const magnet = await desktop.associations.requestDefault({ scheme: "magnet" });
  if (torrent.status !== "confirmed" || magnet.status !== "confirmed") {
    return problem(409, { detail: "Choose Tofu in your system's default application settings" });
  }
  const defaults = await readTorrentDefaults(desktop);
  if (defaults.magnet !== "app.tofu.torrents" || defaults.torrent !== "app.tofu.torrents") {
    return problem(409, {
      detail:
        "The system did not confirm both torrent associations. Move Tofu to Applications and try again.",
    });
  }
  return defaults;
}
