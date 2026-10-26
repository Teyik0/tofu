import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { waitFor } from "../helpers/poll";
import { releaseProvider } from "../helpers/release-provider";

test("anime searches stream usable episodes before completion, limit concurrency to three and reuse source results", async () => {
  const gate = Promise.withResolvers<void>();
  using cleanup = new DisposableStack();
  cleanup.defer(() => gate.resolve());
  await using upstream = releaseProvider();
  upstream.state.nyaaGate = gate.promise;
  upstream.state.nyaaWaitAfter = 1;
  upstream.state.entries = [
    { id: "episode-1", title: "Frieren Beyond Journey’s End S01E01 VOSTFR 1080p x264" },
  ];
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const stream = success(
    await client.anilist.entries({ mediaId: 154_587 }).releases.stream.post({})
  );
  let early = false;
  let complete = false;
  for await (const message of stream) {
    const event = message.data;
    expect(event.type).not.toBe("error");
    if (event.type === "progress" && event.releases.length && !early) {
      early = true;
      expect(event.releases.map((release) => release.episode)).toEqual([1]);
      await waitFor(
        () => upstream.state.activeNyaa,
        (active) => active === 3
      );
      expect(upstream.state.maxActiveNyaa).toBe(3);
      upstream.state.entries = Array.from({ length: 12 }, (_, index) => ({
        id: `episode-${index + 1}`,
        title: `Frieren Beyond Journey’s End S01E${String(index + 1).padStart(2, "0")} VOSTFR 1080p x264`,
      }));
      gate.resolve();
    }
    if (event.type === "complete") {
      complete = true;
      expect(event.result.errors).toEqual([]);
      expect(event.result.releases).toHaveLength(12);
    }
  }
  expect(early).toBe(true);
  expect(complete).toBe(true);
  expect(upstream.state.maxActiveNyaa).toBe(3);
  const requests = upstream.state.requests.length;
  const cached = success(await client.anilist.entries({ mediaId: 154_587 }).releases.post({}));
  expect(cached.releases).toHaveLength(12);
  expect(upstream.state.requests).toHaveLength(requests);
  const { preferences } = success(await client.automation.get());
  success(await client.automation.preferences.put({ ...preferences, resolutions: ["480p"] }));
  const filtered = success(await client.anilist.entries({ mediaId: 154_587 }).releases.post({}));
  expect(filtered.releases).toEqual([]);
  expect(upstream.state.requests).toHaveLength(requests);
  success(await client.plugins({ id: "nyaa" }).put({ enabled: false }));
  expect(
    success(await client.anilist.entries({ mediaId: 154_587 }).releases.post({})).releases
  ).toEqual([]);
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  success(await client.anilist.entries({ mediaId: 154_587 }).releases.post({}));
  expect(upstream.state.requests.length).toBeGreaterThan(requests);
});

test("the release stream reports a mapping failure and closes instead of hanging", async () => {
  await using upstream = releaseProvider();
  upstream.state.mappingStatus = 503;
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  const stream = success(
    await client.anilist.entries({ mediaId: 154_587 }).releases.stream.post({})
  );
  const events: unknown[] = [];
  for await (const message of stream) {
    events.push(message.data);
  }
  expect(events).toEqual([{ detail: "Episode mapping unavailable", status: 502, type: "error" }]);
});

test("closing an episode search cancels pending work without poisoning the next search", async () => {
  const gate = Promise.withResolvers<void>();
  using cleanup = new DisposableStack();
  cleanup.defer(() => gate.resolve());
  await using upstream = releaseProvider();
  upstream.state.nyaaGate = gate.promise;
  upstream.state.entries = [
    { id: "episode-1", title: "Frieren Beyond Journey’s End S01E01 VOSTFR 1080p x264" },
  ];
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const controller = new AbortController();
  const stream = success(
    await client.anilist
      .entries({ mediaId: 154_587 })
      .releases.stream.post({}, { fetch: { signal: controller.signal } })
  );
  await waitFor(
    () => upstream.state.activeNyaa,
    (active) => active === 3
  );
  controller.abort();
  await Promise.allSettled([stream.return()]);
  upstream.state.nyaaGate = null;
  gate.resolve();
  const result = success(await client.anilist.entries({ mediaId: 154_587 }).releases.post({}));
  expect(result.errors).toEqual([]);
  expect(result.releases.map((release) => release.episode)).toEqual([1]);
});
