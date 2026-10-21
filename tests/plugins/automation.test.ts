import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";
import { provider } from "../helpers/provider";

test("an automation downloads a new matching release into its destination exactly once", async () => {
  await using source = await peer();
  await using upstream = provider(source);
  upstream.state.published = false;
  await using app = await application({ provider: upstream.url });
  const { client } = await app.start();
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const destination = success(
    await client.destinations.post({
      downloadPath: join(app.directory, "automated"),
      name: "Anime",
    })
  );
  const draft = success(
    await client.automations.interpret.post({ destinationId: destination.id, query: "Example" })
  );
  const rule = success(
    await client.automations.post({
      ...draft,
      automatic: true,
      enabled: true,
      includeExisting: false,
      languages: ["VOSTFR"],
      matchMode: "exact",
      paused: false,
      sources: ["nyaa"],
      title: "Example",
      waitMinutes: 0,
    })
  );
  success(await client.automations({ id: rule.id }).run.post({}));
  expect(success(await client.state.get()).torrents).toHaveLength(0);
  upstream.state.published = true;
  const detected = success(await client.automations({ id: rule.id }).run.post({}));
  expect(detected.decisions).toContainEqual(
    expect.objectContaining({ status: "added", torrentId: source.id })
  );
  const completed = await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expect(completed.destinationId).toBe(destination.id);
  expectBytes(
    await client.torrents({ id: source.id }).files({ index: "0" }).content.get(),
    source.bytes
  );
  const repeated = success(await client.automations({ id: rule.id }).run.post({}));
  expect(repeated.decisions.filter((decision) => decision.status === "added")).toHaveLength(1);
  expect(success(await client.state.get()).torrents).toHaveLength(1);
});
