import { unlink } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPError } from "elysia";
import parseTorrent from "parse-torrent";
import type { EnginePort } from "../../../types";

// Furin delivers native events in order after application startup.
export async function openDesktopTorrent(
  input: string,
  options: { engine: EnginePort; show: () => void }
) {
  const url = new URL(input);
  let source: string | Uint8Array;
  let sourcePath: string | null = null;
  if (url.protocol === "magnet:") {
    source = input;
  } else if (url.protocol === "file:") {
    const path = fileURLToPath(url);
    if (extname(path).toLowerCase() !== ".torrent") {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Only .torrent files can be opened");
    }
    const file = Bun.file(path);
    if (file.size > 8 * 1024 * 1024) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("The torrent file is too large");
    }
    source = new Uint8Array(await file.arrayBuffer());
    sourcePath = path;
  } else {
    throw new (HTTPError.id("BAD_REQUEST", 400))(
      "Only magnet links and .torrent files can be opened"
    );
  }
  const parsed = await parseTorrent(source);
  const { engine } = options;
  options.show();
  // Reopening an existing torrent must preserve its destination and paused state.
  if (engine.snapshot(null, false).torrents.some((torrent) => torrent.id === parsed.infoHash)) {
    return engine.detail(parsed.infoHash);
  }
  const result = await engine.add(source, { paused: false });
  if (sourcePath !== null && engine.settings.deleteTorrentFileAfterAdd) {
    try {
      await unlink(sourcePath);
    } catch (cause) {
      throw new (HTTPError.id("INTERNAL_SERVER_ERROR", 500))(
        "Torrent added, but the original .torrent file could not be deleted",
        { cause }
      );
    }
  }
  return result;
}
