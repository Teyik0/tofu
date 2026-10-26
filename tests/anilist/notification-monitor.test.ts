import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { createSyncClient, furinSync } from "@teyik0/furin/sync/client";
import type { Api } from "../../src/api";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { waitFor } from "../helpers/poll";
import { provider } from "../helpers/provider";

test("the server detects new episodes in the background and invalidates the inbox and badge", async () => {
  await using upstream = provider();
  await using app = await application({ provider: upstream.url });
  const { client, url } = await app.start();
  success(
    await client.plugins({ id: "anilist" }).put({ apiKey: "test-anilist-token", enabled: true })
  );
  const initial = success(await client.anilist.notifications.check.post());
  expect(initial.hasUpdates).toBe(false);
  const reader = treaty<Api>(url).use(furinSync).api;
  const live = createSyncClient({ url });
  using cleanup = new DisposableStack();
  cleanup.defer(live.close);
  let badge: typeof initial | undefined;
  cleanup.defer(
    live.subscribe(reader.anilist.notifications.status.get.live(), ({ data }) => {
      badge = data;
    })
  );
  await waitFor(
    () => badge,
    (value) => value?.revision === initial.revision
  );
  upstream.state.notifications.unshift({
    ...upstream.state.notifications[0],
    createdAt: Math.floor(Date.now() / 1000),
    episode: 2,
    id: 1000,
    type: "AIRING",
  });
  upstream.state.unreadCount += 1;
  await waitFor(
    () => badge,
    (value) => value?.hasUpdates === true,
    70_000
  );
  expect(upstream.state.notificationRequests).toHaveLength(2);
  expect(success(await client.anilist.notifications.get()).notifications[0]?.id).toBe(1000);
  success(await client.anilist.notifications.read.post({}));
  await waitFor(
    () => badge,
    (value) => value?.hasUpdates === false
  );
  expect(upstream.state.unreadCount).toBe(0);
}, 85_000);

test("wake-up checks deduplicate, ignore social notifications and back off after provider failures", async () => {
  await using upstream = provider();
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(
    await client.plugins({ id: "anilist" }).put({ apiKey: "test-anilist-token", enabled: true })
  );
  const initial = success(await client.anilist.notifications.check.post());
  const duplicates = await Promise.all(
    Array.from({ length: 4 }, () => client.anilist.notifications.check.post())
  );
  expect(duplicates.map(success)).toEqual(Array.from({ length: 4 }, () => initial));
  expect(upstream.state.notificationRequests).toHaveLength(1);
  upstream.state.notifications.unshift({
    ...upstream.state.notifications[1],
    id: 1001,
    type: "FOLLOWING",
  });
  upstream.state.unreadCount += 1;
  await Bun.sleep(5100);
  const gate = Promise.withResolvers<void>();
  using release = new DisposableStack();
  release.defer(gate.resolve);
  upstream.state.anilistGate = gate.promise;
  const before = upstream.state.anilistRequests;
  const checking = Promise.all(
    Array.from({ length: 4 }, () => client.anilist.notifications.check.post())
  );
  await waitFor(
    () => upstream.state.anilistRequests,
    (value) => value === before + 1
  );
  gate.resolve();
  upstream.state.anilistGate = null;
  const checked = (await checking).map(success);
  const [social] = checked;
  if (!social) {
    throw new Error("Concurrent checks returned no notification status");
  }
  expect(checked).toEqual(Array.from({ length: 4 }, () => social));
  expect(upstream.state.anilistRequests).toBe(before + 1);
  expect(social.hasUpdates).toBe(false);
  upstream.state.anilistStatus = 429;
  await Bun.sleep(5100);
  expect((await client.anilist.notifications.check.post()).status).toBe(502);
  const requests = upstream.state.anilistRequests;
  await Bun.sleep(5100);
  success(await client.anilist.notifications.check.post());
  expect(upstream.state.anilistRequests).toBe(requests);
  success(await client.plugins({ id: "anilist" }).put({ enabled: false }));
  expect(success(await client.anilist.notifications.status.get()).hasUpdates).toBe(false);
}, 30_000);

test("shutdown cancels an in-flight notification check", async () => {
  await using upstream = provider();
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client, stop } = await app.start();
  success(
    await client.plugins({ id: "anilist" }).put({ apiKey: "test-anilist-token", enabled: true })
  );
  const gate = Promise.withResolvers<void>();
  using release = new DisposableStack();
  release.defer(gate.resolve);
  upstream.state.anilistGate = gate.promise;
  const before = upstream.state.anilistRequests;
  const checking = Promise.allSettled([client.anilist.notifications.check.post()]);
  await waitFor(
    () => upstream.state.anilistRequests,
    (value) => value === before + 1
  );
  await stop();
  await checking;
});
