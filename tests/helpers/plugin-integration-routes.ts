import { Elysia, HTTPError } from "elysia";
import { integer, minLength, minValue, number, object, pipe, string } from "valibot";
import { automationPlugin } from "../../src/api/modules/automation";
import { draft } from "../../src/api/modules/automation/model";
import { discoveryServicePlugin } from "../../src/api/modules/discovery/plugin";
import { pluginRegistryPlugin } from "../../src/api/modules/plugins/plugin";
import { torrentServicePlugin } from "../../src/api/modules/torrents/plugin";

export const integrationPlugin = new Elysia({ name: "test-plugin-integration" })
  .use(automationPlugin)
  .use(discoveryServicePlugin)
  .use(pluginRegistryPlugin)
  .use(torrentServicePlugin)
  .put("/integration/owned/:key", { body: draft }, async ({ automation, params, body }) => {
    const prepared = await automation.prepareRule(null, body, [], {
      key: params.key,
      ownerId: "test.integration",
    });
    const result = automation.db.transaction((tx) => automation.writeRule(tx, prepared));
    automation.refreshState();
    return result;
  })
  .post(
    "/integration/rules/:id/candidates",
    {
      body: object({
        contentKey: pipe(string(), minLength(1)),
        query: string(),
        revision: pipe(number(), integer(), minValue(0)),
      }),
    },
    async ({ automation, discovery, plugins, torrents, params, body }) => {
      const rule = automation.ruleSnapshot(params.id);
      if (rule?.ownerId !== "test.integration") {
        throw new (HTTPError.id("NOT_FOUND", 404))("Unknown integration rule");
      }
      const found = await discovery.search(body.query, rule.sources);
      const prepared = await automation.prepareIngestion({
        activeSources: plugins
          .snapshot()
          .filter((plugin) => plugin.enabled)
          .map((plugin) => plugin.id),
        candidates: found.releases.map((release) => ({ contentKey: body.contentKey, release })),
        errors: found.errors.map((error) => error.message),
        revision: body.revision,
        ruleId: rule.id,
        torrentIds: torrents.snapshot(null, false).torrents.map((torrent) => torrent.id),
      });
      automation.db.transaction((tx) => automation.writeIngestion(tx, prepared));
      automation.refreshState();
      return automation.snapshot();
    }
  )
  .post("/integration/actions/:id/execute", async ({ automation, discovery, params }) => {
    const decision = automation.decisionRecords().find((item) => item.id === params.id);
    const rule = decision ? automation.ruleSnapshot(decision.automationId) : undefined;
    if (
      !(decision && rule) ||
      rule.ownerId !== "test.integration" ||
      !rule.enabled ||
      decision.status !== "adding"
    ) {
      throw new (HTTPError.id("CONFLICT", 409))("Integration action is not pending");
    }
    const torrent = await discovery.addRelease(
      decision.release.sourceId,
      decision.release.id,
      rule.destinationId,
      rule.paused,
      () =>
        automation.ruleSnapshot(rule.id)?.revision === rule.revision &&
        automation
          .decisionRecords()
          .some((current) => current.id === decision.id && current.status === "adding")
    );
    automation.writeDecisionResult({
      decision,
      reason: "Added by the integration",
      revision: rule.revision,
      status: "added",
      torrentId: torrent.id,
    });
    return automation.snapshot();
  });
