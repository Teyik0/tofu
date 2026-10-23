import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";

test("a Playback desktop window can read existing threads", async () => {
  await using app = await application();
  const { client, url } = await app.start();

  const destination = success(
    await client.destinations.post({
      downloadPath: join(app.directory, "anime"),
      name: "Anime",
    })
  );
  const invitation = success(
    await client.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Desktop",
      role: "playback",
    })
  );
  success(
    await client.connections.put({
      enabled: true,
      proxyOrigin: "https://tofu.example.test",
      transport: "proxy",
    })
  );

  const pairing = success(
    await client.auth.pair.post({
      kind: "desktop",
      label: "Desktop",
      nonce: crypto.randomUUID().replaceAll("-", ""),
      secret: invitation.secret,
    })
  );
  if (!("token" in pairing) || typeof pairing.token !== "string") {
    throw new Error("The server did not issue a desktop credential");
  }

  const desktop = treaty<Api>(url, {
    headers: { authorization: `Bearer ${pairing.token}` },
  }).api;
  const session = success(await desktop.auth["window-sessions"].post());

  const windowClient = treaty<Api>(url, {
    headers: {
      cookie: `${session.cookie}=${session.value}`,
      origin: url,
    },
  }).api;

  expect(success(await windowClient.session.get()).caller).toMatchObject({
    deviceKind: "desktop",
    kind: "device",
    role: "playback",
  });

  const state = success(await windowClient.state.get({ query: { detail: "false" } }));
  expect(state.server).toEqual(pairing.server);
  expect(state.destinations).toContainEqual(
    expect.objectContaining({ id: destination.id, name: "Anime" })
  );
  expect(state.detail).toBeNull();
});

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
