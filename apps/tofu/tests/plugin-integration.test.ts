import { expect, test } from "bun:test";
import { pluginIntegrationFixture } from "./helpers/plugin-integration";
import { expectDefined, expectSuccess } from "./helpers/problem";
import { torrentBytes, waitFor } from "./helpers/torrent";

test("a composed integration owns stable rules, pushes content keys and executes private source downloads", async () => {
  const context = await pluginIntegrationFixture();
  const { client } = context;
  try {
    expectSuccess(
      await client.api
        .plugins({ id: "test.releases" })
        .put({ apiKey: "source-secret", enabled: true })
    );
    const template = expectSuccess(
      await client.api.automations.interpret.post({ destinationId: "default", query: "Example" })
    );
    const draft = {
      ...template,
      automatic: true,
      codecs: ["H.264"],
      includeExisting: true,
      languages: ["VF" as const],
      sources: ["test.releases"],
    };
    const first = expectSuccess(await client.integration.owned({ key: "media:99" }).put(draft));
    const rule = expectSuccess(await client.integration.owned({ key: "media:99" }).put(draft));
    expect(rule.id).toBe(first.id);
    expect(rule.revision).toBe(first.revision + 1);
    expect(rule.ownerId).toBe("test.integration");
    expect(rule.executorId).toBe("test.integration");
    expect(expectSuccess(await client.api.automation.get()).automations).toHaveLength(1);

    const ingested = expectSuccess(
      await client.integration.rules({ id: rule.id }).candidates.post({
        contentKey: "media:99/chapter:1",
        query: "Example",
        revision: rule.revision,
      })
    );
    const [decision] = ingested.decisions;
    expectDefined(decision);
    expect(decision.contentKey).toBe("media:99/chapter:1");
    expect(decision.status).toBe("adding");
    expect(JSON.stringify(ingested)).not.toContain("source-secret");
    expect(expectSuccess(await client.api.state.get()).torrents).toHaveLength(0);

    const { searches } = context.control;
    await context.services.releaseAutomation.start();
    expect(context.control.searches).toBe(searches);
    expect(expectSuccess(await client.api.state.get()).torrents).toHaveLength(0);
    expect((await client.api.automations({ id: rule.id }).run.post({})).status).toBe(409);

    const executed = expectSuccess(
      await client.integration.actions({ id: decision.id }).execute.post({})
    );
    expect(executed.decisions[0]?.status).toBe("added");
    expect(JSON.stringify(executed)).not.toContain("source-secret");
    expect(context.control.downloads).toBe(1);
    expectSuccess(
      await client.api
        .torrents({ id: context.seed.infoHash })
        .peers.post({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
    );
    await waitFor(
      async () => expectSuccess(await client.api.torrents({ id: context.seed.infoHash }).get()),
      (detail) => detail.status === "seeding"
    );
    const bytes = torrentBytes(
      await client.api.torrents({ id: context.seed.infoHash }).files({ index: "0" }).content.get()
    );
    expect(Bun.SHA256.hash(bytes, "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  } finally {
    await context.close();
  }
});

test("concurrent Jev interpretations share a request and shutdown aborts it before closing the database", async () => {
  const context = await pluginIntegrationFixture();
  const { client } = context;
  try {
    expectSuccess(
      await client.api.plugins({ id: "jev" }).put({ apiKey: "test-key", enabled: true })
    );
    const first = client.api.automations.interpret.post({
      destinationId: "default",
      query: "Example",
    });
    const second = client.api.automations.interpret.post({
      destinationId: "default",
      query: "Example",
    });
    await context.control.evaluationStarted.promise;
    expect(context.control.evaluations).toBe(1);
    await context.services.close();
    expect((await first).status).toBe(503);
    expect((await second).status).toBe(503);
  } finally {
    await context.close();
  }
});

test("candidate collection cannot commit after its integration rule is disabled", async () => {
  const context = await pluginIntegrationFixture();
  const { client } = context;
  try {
    expectSuccess(await client.api.plugins({ id: "test.releases" }).put({ enabled: true }));
    const template = expectSuccess(
      await client.api.automations.interpret.post({ destinationId: "default", query: "Example" })
    );
    const draft = {
      ...template,
      automatic: true,
      codecs: ["H.264"],
      includeExisting: true,
      languages: ["VF" as const],
      sources: ["test.releases"],
    };
    const rule = expectSuccess(await client.integration.owned({ key: "media:99" }).put(draft));
    context.control.holdSearch = true;
    const pending = client.integration.rules({ id: rule.id }).candidates.post({
      contentKey: "media:99/chapter:1",
      query: "Example",
      revision: rule.revision,
    });
    await context.control.searchStarted.promise;
    const disabled = expectSuccess(
      await client.api.automations({ id: rule.id }).put({ ...draft, enabled: false })
    );
    expect(disabled.revision).toBe(rule.revision + 1);
    context.control.releaseSearch.resolve();
    expect((await pending).status).toBe(409);
    expect(expectSuccess(await client.api.automation.get()).decisions).toHaveLength(0);
    expect(expectSuccess(await client.api.state.get()).torrents).toHaveLength(0);
  } finally {
    await context.close();
  }
});
