import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { waitFor } from "../helpers/poll";
import { releaseProvider } from "../helpers/release-provider";

test("Tsundere partitions a catalogue beyond 250 entries and shares it across anime searches", async () => {
  await using upstream = releaseProvider();
  upstream.state.entries = Array.from({ length: 600 }, (_, index) => ({
    codec: index % 2 === 0 ? "H.264" : "H.265",
    id: `other-${index}`,
    metadata: { anilistId: 999 },
    quality: index < 300 ? "1080p" : "720p",
    title: "Other Anime - 01 VOSTFR 1080p x264",
  }));
  upstream.state.entries.push(
    {
      codec: "H.264",
      id: "conan",
      metadata: { anilistId: 235 },
      quality: "720p",
      title: "Detective Conan S25E1216 VOSTFR 720p x264",
    },
    {
      codec: "H.264",
      id: "psyren",
      metadata: { anilistId: 204_011 },
      quality: "720p",
      title: "PSYREN S01E04 VOSTFR 720p x264",
    }
  );
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
  const responses = await Promise.all([
    client.anilist.entries({ mediaId: 235 }).releases.post({}),
    client.anilist.entries({ mediaId: 204_011 }).releases.post({}),
  ]);
  for (const [index, response] of responses.entries()) {
    const result = success(response);
    expect(result.errors).toEqual([]);
    expect(result.releases.map((release) => release.id)).toEqual([
      index === 0 ? "conan" : "psyren",
    ]);
  }
  const requests = upstream.state.requests.filter((request) => request.path === "/tsundere");
  expect(requests).toHaveLength(7);
  expect(requests.filter((request) => request.codec !== null)).toHaveLength(4);
  const cached = success(await client.anilist.entries({ mediaId: 235 }).releases.post({}));
  expect(cached.releases).toHaveLength(1);
  expect(upstream.state.requests.filter((request) => request.path === "/tsundere")).toHaveLength(7);
  success(await client.plugins({ id: "tsundere" }).put({ enabled: false }));
  upstream.state.entries = [];
  success(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
  success(await client.discover.post({ query: "Other Anime", sources: ["tsundere"] }));
  expect(upstream.state.requests.filter((request) => request.path === "/tsundere")).toHaveLength(8);
});

test("Tsundere reports incomplete partitions and recovers without caching a failure", async () => {
  await using upstream = releaseProvider();
  upstream.state.entries = Array.from({ length: 260 }, (_, index) => ({
    codec: "H.264",
    id: `psyren-${index}`,
    quality: "1080p",
    title: "PSYREN S01E04 VOSTFR 1080p x264",
  }));
  upstream.state.tsundereIgnoreFilters = true;
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
  const incomplete = success(
    await client.discover.post({ query: "PSYREN", sources: ["tsundere"] })
  );
  expect(incomplete.releases).toEqual([]);
  expect(incomplete.errors).toEqual([
    { message: "Incomplete Tsundere catalogue", sourceId: "tsundere" },
  ]);
  upstream.state.tsundereStatus = 503;
  const failed = success(await client.discover.post({ query: "PSYREN", sources: ["tsundere"] }));
  expect(failed.errors).toEqual([
    { message: "Source unavailable (HTTP 503)", sourceId: "tsundere" },
  ]);
  upstream.state.tsundereStatus = 200;
  upstream.state.entries = upstream.state.entries.slice(0, 1);
  const recovered = success(await client.discover.post({ query: "PSYREN", sources: ["tsundere"] }));
  expect(recovered.errors).toEqual([]);
  expect(recovered.releases.map((release) => release.id)).toEqual(["psyren-0"]);
});

test("disabling Tsundere cancels an in-flight catalogue and allows a fresh search", async () => {
  await using upstream = releaseProvider();
  const gate = Promise.withResolvers<void>();
  using cleanup = new DisposableStack();
  cleanup.defer(() => gate.resolve());
  upstream.state.tsundereGate = gate.promise;
  upstream.state.entries = [{ id: "psyren", title: "PSYREN S01E04 VOSTFR 1080p x264" }];
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
  const pending = client.discover.post({ query: "PSYREN", sources: ["tsundere"] });
  await waitFor(
    () => upstream.state.requests.length,
    (count) => count === 1
  );
  success(await client.plugins({ id: "tsundere" }).put({ enabled: false }));
  gate.resolve();
  const cancelled = success(await pending);
  expect(cancelled.releases).toEqual([]);
  expect(cancelled.errors).toEqual([{ message: "Plugin request cancelled", sourceId: "tsundere" }]);
  upstream.state.tsundereGate = null;
  success(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
  const result = success(await client.discover.post({ query: "PSYREN", sources: ["tsundere"] }));
  expect(result.errors).toEqual([]);
  expect(result.releases.map((release) => release.id)).toEqual(["psyren"]);
});
