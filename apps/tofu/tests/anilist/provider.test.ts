import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { provider } from "../helpers/provider";

test("AniList provider failures are sanitized and a request can recover after its deadline", async () => {
  const gate = Promise.withResolvers<void>();
  using cleanup = new DisposableStack();
  cleanup.defer(() => gate.resolve());
  await using upstream = provider();
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  upstream.state.anilistStatus = 503;
  const failed = await client.anilist.catalog.post({ search: "Example" });
  expect(failed.status).toBe(502);
  expect(failed.error?.value).toMatchObject({ detail: "AniList unavailable (HTTP 503)" });
  expect(JSON.stringify(failed.error?.value)).not.toContain("Private provider diagnostics");
  upstream.state.anilistStatus = 200;
  upstream.state.anilistGate = gate.promise;
  const expired = await client.anilist.catalog.post({ search: "Example" });
  expect(expired.status).toBe(502);
  expect(expired.error?.value).toMatchObject({ detail: "AniList unavailable" });
  upstream.state.anilistGate = null;
  gate.resolve();
  expect(success(await client.anilist.catalog.post({ search: "Example" })).media).toHaveLength(1);
}, 30_000);
