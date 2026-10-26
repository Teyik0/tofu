import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { provider } from "../helpers/provider";

test("source configuration persists, releases are searchable and provider failures are reported", async () => {
  await using source = await peer();
  await using upstream = provider(source);
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  let server = await app.start();
  const initial = success(await server.client.automation.get());
  expect(initial.plugins.find((plugin) => plugin.id === "nyaa")?.enabled).toBe(false);
  const response = await server.client.plugins({ id: "nyaa" }).put({ enabled: true });
  const configured = success(response);
  expect(configured.plugins.find((plugin) => plugin.id === "nyaa")?.enabled).toBe(true);
  expect(JSON.parse(response.response.headers.get("x-furin-queries") ?? "[]")).toContainEqual({
    id: "/api/automation",
    scope: {},
  });
  const updated = success(await server.client.automation.get());
  expect(updated.plugins.find((plugin) => plugin.id === "nyaa")?.enabled).toBe(true);
  const found = success(await server.client.discover.post({ query: "Example", sources: ["nyaa"] }));
  expect(found.errors).toEqual([]);
  expect(found.releases).toHaveLength(1);
  expect(found.releases[0]).toMatchObject({
    episode: 1,
    id: "episode-1",
    infoHash: source.id,
    sourceId: "nyaa",
  });
  await server.stop();
  server = await app.start();
  const saved = success(await server.client.automation.get());
  expect(saved.plugins.find((plugin) => plugin.id === "nyaa")?.enabled).toBe(true);
  upstream.state.failSource = true;
  const tested = await server.client.plugins({ id: "nyaa" }).test.post();
  expect(tested.status).toBe(502);
  expect(tested.error?.value).toMatchObject({ detail: "Source unavailable (HTTP 503)" });
  const failed = success(
    await server.client.discover.post({ query: "Example", sources: ["nyaa"] })
  );
  expect(failed.releases).toEqual([]);
  expect(failed.errors).toEqual([{ message: expect.stringContaining("503"), sourceId: "nyaa" }]);
});
