import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";

test("restart preserves preferences, destinations and partial downloads that can resume", async () => {
  await using source = await peer(512 * 1024);
  await using app = await application();
  let server = await app.start();
  success(await server.client.settings.patch({ downloadLimit: 128 * 1024 }));
  const destination = success(
    await server.client.destinations.post({
      downloadPath: join(app.directory, "anime"),
      name: "Anime",
    })
  );
  success(
    await server.client.torrents.post({
      destinationId: destination.id,
      paused: false,
      source: source.magnet,
    })
  );
  await waitFor(
    async () => success(await server.client.torrents({ id: source.id }).get()),
    (torrent) => (torrent.downloaded ?? 0) > 0 && (torrent.progress ?? 1) < 1
  );
  success(await server.client.torrents({ id: source.id }).pause.post({}));
  const before = success(await server.client.torrents({ id: source.id }).get());
  await server.stop();
  server = await app.start();
  const state = success(await server.client.state.get());
  expect(state.torrents).toHaveLength(1);
  expect(state.torrents[0]?.destinationId).toBe(destination.id);
  const settings = success(await server.client.settings.get());
  expect(settings.downloadLimit).toBe(128 * 1024);
  const after = success(await server.client.torrents({ id: source.id }).get());
  expect(after.status).toBe("paused");
  expect(after.downloaded).toBe(before.downloaded);
  success(await server.client.torrents({ id: source.id }).resume.post({}));
  await waitFor(
    async () => success(await server.client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expectBytes(
    await server.client.torrents({ id: source.id }).files({ index: "0" }).content.get(),
    source.bytes
  );
});
