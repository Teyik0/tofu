import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { provider } from "../helpers/provider";

test("source configuration persists, releases are searchable and provider failures are reported", async () => {
  await using source = await peer();
  await using upstream = provider(source);
  await using app = await application({ provider: upstream.url });
  let server = await app.start();
  const configured = success(await server.client.plugins({ id: "nyaa" }).put({ enabled: true }));
  expect(configured.plugins.find((plugin) => plugin.id === "nyaa")?.enabled).toBe(true);
  await server.stop();
  server = await app.start();
  const saved = success(await server.client.automation.get());
  expect(saved.plugins.find((plugin) => plugin.id === "nyaa")?.enabled).toBe(true);
  const found = success(await server.client.discover.post({ query: "Example", sources: ["nyaa"] }));
  expect(found.errors).toEqual([]);
  expect(found.releases).toHaveLength(1);
  expect(found.releases[0]).toMatchObject({
    episode: 1,
    id: "episode-1",
    infoHash: source.id,
    sourceId: "nyaa",
  });
  upstream.state.failSource = true;
  const failed = success(
    await server.client.discover.post({ query: "Example", sources: ["nyaa"] })
  );
  expect(failed.releases).toEqual([]);
  expect(failed.errors).toEqual([{ message: expect.stringContaining("503"), sourceId: "nyaa" }]);
});
