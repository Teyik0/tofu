import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { application } from "../helpers/app";
import { sessionCookie, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";

test("saved servers keep their threads and permissions independent when one goes offline", async () => {
  await using source = await peer();
  await using firstApp = await application();
  await using secondApp = await application();

  const [first, second] = await Promise.all([firstApp.start(), secondApp.start()]);

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
    targets.map(async ({ app, remote, name, role }) => {
      const root = success(
        await remote.client["storage-roots"].post({
          name: "Library",
          path: app.directory,
        })
      );
      const thread = success(
        await remote.client.destinations.post({
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
            origins: [remote.url],
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
  const desktop = await desktopApp.start();

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
    expect(result.threads).not.toContainEqual(expect.objectContaining({ id: other.thread.id }));
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
    (state) => state.snapshot?.torrents.some((torrent) => torrent.id === source.id) === true
  );
  expect(updated.snapshot?.torrents).toContainEqual({
    destinationId: added.id,
    id: source.id,
  });

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

  success(
    await secondFixture.owner.access
      .devices({
        id: secondFixture.connection.server.deviceId,
      })
      .delete()
  );
  const revoked = await waitFor(
    async () =>
      success(await desktop.client.desktop.servers({ id: secondFixture.identity.id }).state.get()),
    (state) => state.connection === "unauthorized"
  );
  expect(revoked.snapshot).toBeNull();
  expect(revoked.failure?.status).toBe(401);
  await desktop.stop();
}, 60_000);
