import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { transmissionServer } from "../helpers/transmission-server";

test("a Transmission server is configured, read, and controlled through RPC", async () => {
  using transmission = transmissionServer();
  await using app = await application();
  const { client } = await app.start();

  const created = success(
    await client.transmission.servers.post({
      name: "Remote daemon",
      origin: transmission.url,
      rpcPath: "/transmission/rpc",
    })
  );
  expect(success(await client.transmission.servers.get())).toHaveLength(1);

  const state = success(await client.transmission.servers({ id: created.id }).state.get());
  expect(transmission.calls).toContain("session-get");
  expect(state.session.version).toBe("2.83 (30)");
  expect(state.session.torrentCount).toBe(1);
  expect(state.session.peerLimitGlobal).toBe(1000);
  expect(state.session.peerLimitPerTorrent).toBe(50);
  expect(state.session.seedRatioLimit).toBe(2);
  expect(state.session.idleSeedingLimit).toBe(30);
  expect(state.torrents[0]?.state).toBe("downloading");
  expect(state.torrents[0]?.progress).toBe(0.25);
  expect(state.torrents[0]?.eta).toBe(120);

  success(
    await client.transmission.servers({ id: created.id }).action.post({ action: "stop", ids: [1] })
  );
  expect(transmission.calls).toContain("torrent-stop");
  const stopped = success(await client.transmission.servers({ id: created.id }).state.get());
  expect(stopped.torrents[0]?.state).toBe("stopped");

  success(
    await client.transmission.servers({ id: created.id }).action.post({
      action: "start-now",
      ids: [1],
    })
  );
  expect(transmission.calls).toContain("torrent-start-now");

  const added = success(
    await client.transmission.servers({ id: created.id }).torrents.post({
      paused: true,
      source: "magnet:?xt=urn:btih:example",
    })
  );
  expect(added.infoHash).toHaveLength(40);
  expect(transmission.torrents).toHaveLength(2);

  const limits = success(
    await client.transmission.servers({ id: created.id }).limits.put({
      downloadLimit: 500,
      downloadLimited: true,
      idleSeedingLimit: 45,
      idleSeedingLimitEnabled: true,
      peerLimitGlobal: 200,
      peerLimitPerTorrent: 25,
      seedRatioLimit: 1.5,
      seedRatioLimited: true,
    })
  );
  expect(limits.downloadLimit).toBe(500);
  expect(limits.downloadLimited).toBe(true);
  expect(limits.peerLimitGlobal).toBe(200);
  expect(limits.peerLimitPerTorrent).toBe(25);
  expect(limits.seedRatioLimit).toBe(1.5);
  expect(limits.seedRatioLimited).toBe(true);
  expect(limits.idleSeedingLimit).toBe(45);
  expect(limits.idleSeedingLimitEnabled).toBe(true);

  success(
    await client.transmission
      .servers({ id: created.id })
      .torrents({ torrentId: "1" })
      .files.put({ wanted: [0] })
  );
  expect(transmission.files.wanted).toEqual([[0]]);
  expect(transmission.files.unwanted).toEqual([[1]]);

  const detail = success(
    await client.transmission.servers({ id: created.id }).torrents({ torrentId: "1" }).get()
  );
  expect(detail.files).toHaveLength(2);
  expect(detail.files[0]?.name).toBe("example.bin");
  expect(detail.magnetLink).toContain("magnet:?xt=urn:btih:");
  expect(detail.addedDate).toBe(1_700_000_000);
  expect(detail.secondsDownloading).toBe(3600);
  expect(detail.trackers[0]?.seederCount).toBe(4);
  expect(detail.peers[0]?.address).toBe("203.0.113.5:51413");
  expect(detail.honorsSessionLimits).toBe(true);

  success(
    await client.transmission.servers({ id: created.id }).action.post({
      action: "reannounce",
      ids: [1],
    })
  );
  expect(transmission.calls).toContain("torrent-reannounce");

  success(
    await client.transmission.servers({ id: created.id }).torrents.delete({
      deleteLocalData: true,
      ids: [1],
    })
  );
  expect(transmission.deleted).toContainEqual({ deleteLocalData: true, ids: [1] });
  expect(transmission.torrents).toHaveLength(1);

  success(await client.transmission.servers({ id: created.id }).delete());
  expect(success(await client.transmission.servers.get())).toHaveLength(0);
});

test("Transmission credentials reach the daemon and rejections surface as 401", async () => {
  using transmission = transmissionServer({ password: "secret", username: "tofu" });
  await using app = await application();
  const { client } = await app.start();

  const created = success(
    await client.transmission.servers.post({
      name: "Remote daemon",
      origin: transmission.url,
      password: "wrong",
      rpcPath: "/transmission/rpc",
      username: "tofu",
    })
  );
  const denied = await client.transmission.servers({ id: created.id }).state.get();
  expect(denied.error?.status).toBe(401);

  success(
    await client.transmission.servers({ id: created.id }).put({
      name: "Remote daemon",
      origin: transmission.url,
      password: "secret",
      rpcPath: "/transmission/rpc",
      username: "tofu",
    })
  );
  const state = success(await client.transmission.servers({ id: created.id }).state.get());
  expect(state.torrents).toHaveLength(1);
});
