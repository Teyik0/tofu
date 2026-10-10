import { expect, test } from "bun:test";
import { createSyncChangesPlugin } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { createEngineChangePublisher } from "../src/api/lib/lifecycle";
import { fixture, waitFor } from "./helpers";

test("engine polling publishes changed snapshots and leaves idle clients alone", async () => {
  const context = await fixture(4096, []);
  try {
    const app = new Elysia().use(createSyncChangesPlugin(context.sync.options));
    const readChanges = async () =>
      (await app.handle("http://localhost/_furin/sync/changes?after=0")).json();
    const publish = createEngineChangePublisher(context.sync.options, context.engine);
    const initial = await readChanges();
    await publish();
    await publish();
    expect(await readChanges()).toEqual(initial);
    await waitFor(
      async () => context.engine.snapshot(null, false).history,
      (history) => history.length > 0
    );
    await publish();
    expect(await readChanges()).toEqual(initial);

    await context.engine.add(context.magnet, { paused: true });
    await publish();
    const changed = await readChanges();
    expect(changed.cursor).not.toBe(initial.cursor);
    expect(changed.reset).toBe(true);

    await publish();
    expect(await readChanges()).toEqual(changed);
  } finally {
    await context.close();
  }
});
