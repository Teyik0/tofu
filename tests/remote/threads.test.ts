import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { application } from "../helpers/app";
import { sessionCookie, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";
import { remoteRelay } from "../helpers/remote-relay";

test("saved servers keep their threads and permissions independent when one goes offline", async () => {
  await using source = await peer();
  await using firstApp = await application();
  await using secondApp = await application();

  const [first, second] = await Promise.all([firstApp.start(), secondApp.start()]);
  await using relay = remoteRelay(first.url);

  const targets = [
    {
      app: firstApp,
      name: "First server anime",
      remote: first,
      role: "playback" as const,
    },
    {
      app: secondApp,
      name: "Second server anime",
      remote: second,
      role: "management" as const,
    },
  ];

  const fixtures = await Promise.all(
    targets.map(async ({ app, remote, name, role }, index) => {
      const root = success(
        await remote.client["storage-roots"].post({
          name: "Library",
          path: app.directory,
        })
      );
      const thread = success(
        await remote.client.destinations({ id: "default" }).put({
          downloadPath: join(app.directory, "anime"),
          name,
        })
      );

      const invitation = success(
        await remote.client.access.invitations.post({
          canDeleteFiles: false,
          expiresInMinutes: 10,
          label: "Desktop",
          role,
        })
      );

      const sharing = await remote.client.connections.put({
        enabled: true,
        proxyOrigin: "https://tofu.example.test",
        transport: "proxy",
      });
      success(sharing);

      const pairing = success(
        await remote.client.auth.pair.post({
          kind: "desktop",
          label: "Desktop",
          nonce: crypto.randomUUID().replaceAll("-", ""),
          secret: invitation.secret,
        })
      );

      if (!("token" in pairing) || typeof pairing.token !== "string") {
        throw new Error("The server did not issue a desktop credential");
      }

      return {
        connection: {
          server: {
            alias: "",
            deviceId: pairing.device.id,
            name: pairing.server.name,
            origins: index === 0 ? ["http://127.0.0.1:0", remote.url] : [remote.url],
            serverId: pairing.server.id,
            temporary: true,
          },
          token: pairing.token,
        },
        identity: pairing.server,
        owner: treaty<Api>(remote.url, {
          headers: { cookie: sessionCookie(sharing.response), origin: remote.url },
        }).api,
        root,
        thread,
      };
    })
  );

  const [firstFixture, secondFixture] = fixtures;
  if (!(firstFixture && secondFixture)) {
    throw new Error("Both remote server fixtures are required");
  }

  await using desktopApp = await application({
    remoteServers: fixtures.map((fixture) => fixture.connection),
  });
  let changed = Promise.withResolvers<void>();
  const desktop = await desktopApp.start({
    onMessage(message) {
      if (
        typeof message === "object" &&
        message !== null &&
        "changed" in message &&
        message.changed === firstFixture.identity.id
      ) {
        changed.resolve();
      }
    },
  });

  const page = await fetch(`${desktop.url}/servers/${firstFixture.identity.id}/thread/default`);
  expect(page.status).toBe(200);

  const initial = await waitFor(
    async () =>
      success(await desktop.client.desktop.servers({ id: firstFixture.identity.id }).state.get()),
    (state) => state.connection === "ready"
  );

  expect(initial.snapshot?.server).toEqual(firstFixture.identity);
  expect(initial.failure).toBeNull();

  const responses = await Promise.all([
    desktop.client.desktop.servers({ id: firstFixture.identity.id }).threads.get(),
    desktop.client.desktop.servers({ id: secondFixture.identity.id }).threads.get(),
  ]);

  for (const [index, response] of responses.entries()) {
    const fixture = fixtures[index];
    const other = fixtures[1 - index];
    if (!(fixture && other)) {
      throw new Error("Both remote server fixtures are required");
    }

    const result = success(response);

    expect(result.server).toEqual(fixture.identity);
    expect(result.threads).toContainEqual(
      expect.objectContaining({
        id: fixture.thread.id,
        name: fixture.thread.name,
      })
    );
    expect(result.threads).not.toContainEqual(
      expect.objectContaining({ id: other.thread.id, name: other.thread.name })
    );
    expect(result.capabilities).toMatchObject({
      administer: false,
      deleteFiles: false,
      manage: index === 1,
      owner: false,
    });

    const serialized = JSON.stringify(result);
    for (const fixtureSource of fixtures) {
      expect(serialized).not.toContain(fixtureSource.connection.token);
    }
    expect(serialized).not.toContain(firstApp.directory);
    expect(serialized).not.toContain(secondApp.directory);
  }

  const connected = success(
    await desktop.client.desktop.servers({ id: firstFixture.identity.id }).state.get()
  );

  expect(connected.connection).toBe("ready");
  expect(connected.snapshot?.server).toEqual(firstFixture.identity);
  expect(connected.snapshot?.threads).toContainEqual(
    expect.objectContaining({ id: firstFixture.thread.id })
  );
  expect(connected.failure).toBeNull();

  const added = success(
    await firstFixture.owner.destinations["within-root"].post({
      folder: "live-anime",
      name: "Live anime",
      rootId: firstFixture.root.id,
    })
  );
  await waitFor(
    async () =>
      success(await desktop.client.desktop.servers({ id: firstFixture.identity.id }).state.get()),
    (state) => state.snapshot?.threads.some((thread) => thread.id === added.id) === true
  );

  success(
    await firstFixture.owner.torrents.post({
      destinationId: added.id,
      paused: false,
      source: source.magnet,
    })
  );
  const updated = await waitFor(
    async () =>
      success(await desktop.client.desktop.servers({ id: firstFixture.identity.id }).state.get()),
    (state) => {
      const torrent = state.snapshot?.torrents.find((item) => item.id === source.id);
      return torrent?.name === source.filename && torrent.length === source.bytes.byteLength;
    }
  );
  expect(updated.snapshot?.torrents).toContainEqual(
    expect.objectContaining({
      destinationId: added.id,
      id: source.id,
      length: source.bytes.byteLength,
      name: source.filename,
    })
  );
  const serialized = JSON.stringify(updated.snapshot);
  expect(serialized).not.toContain(firstApp.directory);
  expect(serialized).not.toContain(firstFixture.connection.token);

  success(
    await secondFixture.owner.torrents.post({
      destinationId: secondFixture.thread.id,
      paused: false,
      source: source.magnet,
    })
  );
  await waitFor(
    async () => success(await secondFixture.owner.torrents({ id: source.id }).get()),
    (torrent) => torrent.files.length > 0
  );

  const firstDetail = success(
    await desktop.client.desktop
      .servers({ id: firstFixture.identity.id })
      .threads({ threadId: added.id })
      .torrents({ torrentId: source.id })
      .get()
  );
  const secondDetail = success(
    await desktop.client.desktop
      .servers({ id: secondFixture.identity.id })
      .threads({ threadId: secondFixture.thread.id })
      .torrents({ torrentId: source.id })
      .get()
  );
  expect(firstDetail.server.id).toBe(firstFixture.identity.id);
  expect(firstDetail.torrent.destinationId).toBe(added.id);
  expect(secondDetail.server.id).toBe(secondFixture.identity.id);
  expect(secondDetail.torrent.destinationId).toBe(secondFixture.thread.id);
  expect(firstDetail.torrent.files).toContainEqual(
    expect.objectContaining({ length: source.bytes.byteLength, name: source.filename })
  );
  expect(
    (
      await desktop.client.desktop
        .servers({ id: firstFixture.identity.id })
        .threads({ threadId: firstFixture.thread.id })
        .torrents({ torrentId: source.id })
        .get()
    ).status
  ).toBe(404);
  for (const detail of [firstDetail, secondDetail]) {
    const encoded = JSON.stringify(detail);
    expect(encoded).not.toContain(firstApp.directory);
    expect(encoded).not.toContain(secondApp.directory);
    for (const fixture of fixtures) {
      expect(encoded).not.toContain(fixture.connection.token);
    }
  }

  success(
    await firstFixture.owner.access
      .devices({
        id: firstFixture.connection.server.deviceId,
      })
      .patch({ role: "management" })
  );
  await waitFor(
    async () =>
      success(await desktop.client.desktop.servers({ id: firstFixture.identity.id }).state.get()),
    (state) => state.snapshot?.capabilities.manage === true
  );
  success(
    await firstFixture.owner.access
      .devices({
        id: firstFixture.connection.server.deviceId,
      })
      .patch({ role: "playback" })
  );
  await waitFor(
    async () =>
      success(await desktop.client.desktop.servers({ id: firstFixture.identity.id }).state.get()),
    (state) => state.connection === "ready" && state.snapshot.capabilities.manage === false
  );

  await first.stop();

  const offline = await waitFor(
    async () =>
      success(await desktop.client.desktop.servers({ id: firstFixture.identity.id }).state.get()),
    (state) => state.connection === "offline"
  );

  expect(offline.connection).toBe("offline");
  expect(offline.snapshot).toBeNull();
  expect(offline.failure).not.toBeNull();

  const stillConnected = success(
    await desktop.client.desktop.servers({ id: secondFixture.identity.id }).state.get()
  );

  expect(stillConnected.connection).toBe("ready");
  expect(stillConnected.snapshot?.server).toEqual(secondFixture.identity);

  expect(stillConnected.snapshot?.threads).toContainEqual(
    expect.objectContaining({
      id: secondFixture.thread.id,
      name: secondFixture.thread.name,
    })
  );
  expect(stillConnected.snapshot?.capabilities.manage).toBe(true);

  await firstApp.start({ port: Number(new URL(first.url).port) });
  const recovered = await waitFor(
    async () =>
      success(await desktop.client.desktop.servers({ id: firstFixture.identity.id }).state.get()),
    (state) => state.connection === "ready"
  );
  expect(recovered.snapshot?.threads).toContainEqual(expect.objectContaining({ id: added.id }));

  await using stalled = remoteRelay(first.url);
  stalled.control.identityHold = Promise.withResolvers<void>();
  desktop.child.send({
    origins: [stalled.url, first.url],
    serverId: firstFixture.identity.id,
    type: "remote-catalog",
  });
  await changed.promise;

  const fallbackThreads = success(
    await desktop.client.desktop.servers({ id: firstFixture.identity.id }).threads.get()
  );
  expect(fallbackThreads.server.id).toBe(firstFixture.identity.id);
  expect(fallbackThreads.threads).toContainEqual(expect.objectContaining({ id: added.id }));

  const fallbackDetail = success(
    await desktop.client.desktop
      .servers({ id: firstFixture.identity.id })
      .threads({ threadId: added.id })
      .torrents({ torrentId: source.id })
      .get()
  );
  expect(fallbackDetail.server.id).toBe(firstFixture.identity.id);
  expect(fallbackDetail.torrent.id).toBe(source.id);

  changed = Promise.withResolvers<void>();
  desktop.child.send({
    origins: [relay.url],
    serverId: firstFixture.identity.id,
    type: "remote-catalog",
  });
  await changed.promise;

  for (const origins of [[relay.url, first.url], undefined]) {
    const gate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    relay.control.gate = gate;
    changed = Promise.withResolvers<void>();

    const reading = desktop.client.desktop.servers({ id: firstFixture.identity.id }).threads.get();
    // biome-ignore lint/performance/noAwaitInLoops: Each catalog change must finish before the next delayed read starts.
    await gate.entered.promise;
    desktop.child.send({
      origins,
      serverId: firstFixture.identity.id,
      type: "remote-catalog",
    });
    await changed.promise;
    gate.release.resolve();
    const result = await reading;
    expect(result.status).toBe(409);
    expect(result.data).toBeNull();
    expect(
      success(await desktop.client.desktop.servers({ id: secondFixture.identity.id }).state.get())
        .connection
    ).toBe("ready");
  }

  const beforeResponse = await fetch(`${desktop.url}/_furin/sync/changes`);
  expect(beforeResponse.status).toBe(200);
  const before = (await beforeResponse.json()) as { cursor: string };
  {
    using database = new Database(join(desktopApp.directory, "state", "tofu.sqlite"));
    database.exec("BEGIN IMMEDIATE");
    using transaction = new DisposableStack();
    transaction.defer(() => database.exec("ROLLBACK"));

    success(
      await secondFixture.owner.access
        .devices({ id: secondFixture.connection.server.deviceId })
        .delete()
    );
    await waitFor(
      async () => {
        const files = await Array.fromAsync(
          new Bun.Glob("*.jsonl").scan({
            absolute: true,
            cwd: join(desktopApp.directory, "state", "logs"),
          })
        );
        const contents = await Promise.all(files.map((file) => Bun.file(file).text()));
        return contents.some((content) =>
          content
            .split("\n")
            .some(
              (line) =>
                line.includes('"invalidate-remote-state"') &&
                line.includes(secondFixture.identity.id)
            )
        );
      },
      (failed) => failed,
      20_000
    );
  }
  await waitFor(
    async () => {
      const response = await fetch(`${desktop.url}/_furin/sync/changes`);
      expect(response.status).toBe(200);
      return (await response.json()) as { cursor: string };
    },
    (updates) => updates.cursor !== before.cursor
  );
  const revoked = await waitFor(
    async () =>
      success(await desktop.client.desktop.servers({ id: secondFixture.identity.id }).state.get()),
    (state) => state.connection === "unauthorized"
  );
  expect(revoked.snapshot).toBeNull();
  expect(revoked.failure?.status).toBe(401);
  expect(
    (
      await desktop.client.desktop
        .servers({ id: secondFixture.identity.id })
        .threads({ threadId: secondFixture.thread.id })
        .torrents({ torrentId: source.id })
        .get()
    ).status
  ).toBe(401);
  await desktop.stop();
}, 60_000);
