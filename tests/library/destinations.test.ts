import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";

test("a torrent downloads into the selected library destination", async () => {
  await using source = await peer();
  await using app = await application();
  const { client } = await app.start();
  const downloadPath = join(app.directory, "anime");
  const destination = success(await client.destinations.post({ downloadPath, name: "Anime" }));
  success(
    await client.torrents.post({
      destinationId: destination.id,
      paused: false,
      source: source.magnet,
    })
  );
  const completed = await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expect(completed.destinationId).toBe(destination.id);
  expect(new Uint8Array(await Bun.file(join(downloadPath, source.filename)).bytes())).toEqual(
    new Uint8Array(source.bytes)
  );
  expect(await Bun.file(join(app.downloadPath, source.filename)).exists()).toBe(false);
  expectBytes(
    await client.torrents({ id: source.id }).files({ index: "0" }).content.get(),
    source.bytes
  );
});
