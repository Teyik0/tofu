import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { application } from "../helpers/app";
import { sessionCookie, success } from "../helpers/assert";

test("linked libraries pair, query availability and revoke their remote credential", async () => {
  await using upstream = await application({ entry: "tests/helpers/providers-server.ts" });
  await using downstream = await application({ entry: "tests/helpers/providers-server.ts" });
  const remote = await upstream.start();
  let local = await downstream.start();
  const shared = await remote.client.connections.put({
    enabled: true,
    proxyOrigin: "https://library.example.test",
    transport: "proxy",
  });
  success(shared);
  const owner = treaty<Api>(remote.url, {
    headers: { cookie: sessionCookie(shared.response), origin: remote.url },
  }).api;
  const invitation = success(
    await owner.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Linked library",
      role: "playback",
    })
  );
  const link = success(
    await local.client["linked-libraries"].post({
      address: remote.url,
      label: "Downstream server",
      secret: invitation.secret,
    })
  );
  expect(link.state).toBe("active");
  expect(success(await owner.access.devices.get())).toContainEqual(
    expect.objectContaining({ kind: "server", label: "Downstream server" })
  );
  expect(
    success(
      await local.client["linked-libraries"].availability.post({
        episodes: [1],
        infoHashes: [],
        key: "example",
        season: null,
        titles: ["Example"],
      })
    )
  ).toContainEqual(expect.objectContaining({ sources: [], state: "none" }));
  expect(
    (
      await local.client["linked-libraries"]({ id: link.id }).play.post({
        fileIndex: 0,
        torrentId: "missing",
      })
    ).status
  ).toBe(404);
  await local.stop();
  local = await downstream.start();
  expect(success(await local.client["linked-libraries"].get())).toContainEqual(
    expect.objectContaining({ id: link.id, state: "active" })
  );
  expect(success(await local.client["linked-libraries"]({ id: link.id }).delete())).toEqual({
    removed: true,
    revokedRemotely: true,
  });
  expect(success(await local.client["linked-libraries"].get())).toEqual([]);
});
