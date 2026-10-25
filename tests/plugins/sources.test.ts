import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
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

test("Jev credentials reject invalid provider answers and accept a schema-valid response", async () => {
  await using upstream = provider();
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  upstream.state.jevResponse = {
    answers: { connected: { noul: 2, type: "noul" } },
    model: "jev-latest",
  };
  expect(
    (await client.plugins({ id: "jev" }).connect.post({ apiKey: "test-jev-key", enabled: true }))
      .status
  ).toBe(502);
  upstream.state.jevResponse = {
    answers: { connected: { noul: 0.9, type: "noul" } },
    model: "jev-latest",
  };
  expect(
    success(
      await client.plugins({ id: "jev" }).connect.post({ apiKey: "test-jev-key", enabled: true })
    ).plugins
  ).toContainEqual(expect.objectContaining({ enabled: true, id: "jev" }));
});

test("Jev reuses valid persisted answers and recalculates invalid cached answers", async () => {
  await using upstream = provider();
  upstream.state.jevResponse = {
    answers: { connected: { noul: 0.9, type: "noul" } },
    model: "jev-latest",
  };
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  let server = await app.start();
  success(
    await server.client.plugins({ id: "jev" }).put({ apiKey: "test-jev-key", enabled: true })
  );
  success(await server.client.plugins({ id: "jev" }).test.post());
  expect(upstream.state.jevRequests).toBe(1);
  await server.stop();
  server = await app.start();
  success(await server.client.plugins({ id: "jev" }).test.post());
  expect(upstream.state.jevRequests).toBe(1);
  await server.stop();
  {
    using db = new Database(join(app.directory, "state/tofu.sqlite"));
    db.run("UPDATE judgements SET value = ?", [
      JSON.stringify({
        answers: { connected: { noul: 2, type: "noul" } },
        model: "jev-latest",
      }),
    ]);
    expect(db.query("SELECT id FROM judgements").all()).toHaveLength(1);
  }
  server = await app.start();
  success(await server.client.plugins({ id: "jev" }).test.post());
  expect(upstream.state.jevRequests).toBe(2);
});
