import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { pluginEndpoints } from "../src/api/modules/plugins/service";
import { createTestApi } from "./helpers/application";
import { expectSuccess } from "./helpers/problem";
import { openTestServices } from "./helpers/services";
import { fixture } from "./helpers/torrent";

test("creating and deleting an automation can be replayed without creating a second rule or restoring a deleted rule", async () => {
  const context = await fixture(1024, []);
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: pluginEndpoints,
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  const draft = {
    ...expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    ),
    includeExisting: true,
  };
  try {
    const created = await client.automations.post(draft, {
      headers: { "idempotency-key": "create-rule" },
    });
    expect(created.status).toBe(200);
    const rule = expectSuccess(created);
    const replay = await client.automations.post(draft, {
      headers: { "idempotency-key": "create-rule" },
    });
    expect(replay.status).toBe(200);
    expect(expectSuccess(replay)).toEqual(rule);
    expect(expectSuccess(await client.automation.get()).automations).toHaveLength(1);
    expect(
      (
        await client
          .automations({ id: rule.id })
          .delete({}, { headers: { "idempotency-key": "delete-rule" } })
      ).status
    ).toBe(200);
    expect(
      (
        await client
          .automations({ id: rule.id })
          .delete({}, { headers: { "idempotency-key": "delete-rule" } })
      ).status
    ).toBe(200);
    expect(
      (await client.automations.post(draft, { headers: { "idempotency-key": "create-rule" } }))
        .status
    ).toBe(200);
    expect(expectSuccess(await client.automation.get()).automations).toHaveLength(0);
  } finally {
    await service.close();
    await context.close();
  }
});
