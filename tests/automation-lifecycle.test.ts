import { expect, test } from "bun:test";
import { join } from "node:path";
import { automationFixture } from "./helpers/automation";
import { expectDefined, expectProblem, expectSuccess } from "./helpers/problem";
import { fixture, waitFor } from "./helpers/torrent";

test("deleting a rule cancels its pending decisions and preserves downloaded history", async () => {
  const context = await fixture(1024, []);
  const upstream = Bun.serve({
    fetch: () =>
      Response.json({
        entries: [1, 2].map((episode) => ({
          episode,
          id: `episode-${episode}`,
          season: 1,
          title: `Example S01E${episode} VOSTFR 1080p x264`,
          torrentUrl: context.magnet,
        })),
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const { client, service } = await automationFixture(
    context.directory,
    context,
    upstream.url.href
  );
  try {
    expectSuccess(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
    const draft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    );
    const rule = expectSuccess(
      await client.automations.post({
        ...draft,
        automatic: false,
        includeExisting: true,
        sources: ["tsundere"],
      })
    );
    const checked = expectSuccess(await client.automations({ id: rule.id }).run.post());
    expect(checked.decisions).toHaveLength(2);
    const [download, pending] = checked.decisions;
    expectDefined(download);
    expectDefined(pending);
    expect(download.status).toBe("review");
    expect(pending.status).toBe("review");
    const approved = expectSuccess(
      await client["automation-decisions"]({ id: download.id }).approve.post()
    );
    expect(approved.decisions.find((decision) => decision.id === download.id)?.status).toBe(
      "added"
    );
    await waitFor(
      async () => expectSuccess(await client.torrents({ id: context.seed.infoHash }).get()),
      (torrent) => torrent.status === "seeding"
    );
    expectSuccess(await client.automations({ id: rule.id }).delete({}));
    const state = expectSuccess(await client.automation.get());
    expect(state.automations).toHaveLength(0);
    expect(state.decisions.find((decision) => decision.id === pending.id)).toMatchObject({
      reason: "Automation deleted",
      status: "ignored",
    });
    expect(state.decisions.find((decision) => decision.id === download.id)).toMatchObject({
      status: "added",
      torrentId: context.seed.infoHash,
    });
    expectSuccess(await client["automation-decisions"]({ id: pending.id }).approve.post());
    expect(expectSuccess(await client.state.get()).torrents).toHaveLength(1);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("the automation snapshot keeps every pending decision and caps only terminal history", async () => {
  const context = await fixture(1024, []);
  const upstream = Bun.serve({
    fetch: () =>
      Response.json({
        entries: Array.from({ length: 350 }, (_, index) => ({
          episode: index + 1,
          id: `episode-${index + 1}`,
          season: 1,
          title: `Example S01E${index + 1} VOSTFR 1080p x264`,
          torrentUrl: context.magnet,
        })),
      }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const { client, service } = await automationFixture(
    context.directory,
    context,
    upstream.url.href
  );
  try {
    expectSuccess(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
    const draft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    );
    const input = { ...draft, automatic: false, sources: ["tsundere"] };
    expectSuccess(await client.automations.post({ ...input, includeExisting: false }));
    const rule = expectSuccess(await client.automations.post({ ...input, includeExisting: true }));
    expectSuccess(await client.automations({ id: rule.id }).run.post());
    const state = expectSuccess(await client.automation.get());
    expect(state.decisions.filter((decision) => decision.status === "review")).toHaveLength(350);
    expect(state.decisions.filter((decision) => decision.status === "ignored")).toHaveLength(300);
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});

test("creating a rule fails if its destination is deleted during the baseline search", async () => {
  const context = await fixture(1024, []);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    async fetch() {
      entered.resolve();
      await gate.promise;
      return Response.json({ entries: [] });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const { client, service } = await automationFixture(
    context.directory,
    context,
    upstream.url.href
  );
  try {
    expectSuccess(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
    const draft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    );
    const destination = expectSuccess(
      await client.destinations.post({
        downloadPath: join(context.directory, "removed-destination"),
        name: "Temporary destination",
      })
    );
    const saving = client.automations.post({
      ...draft,
      destinationId: destination.id,
      includeExisting: false,
      sources: ["tsundere"],
    });
    await entered.promise;
    expectSuccess(await client.destinations({ id: destination.id }).delete({}));
    gate.resolve();
    expectProblem(await saving, 400, "Unknown destination");
    expect(expectSuccess(await client.automation.get()).automations).toHaveLength(0);
  } finally {
    gate.resolve();
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
