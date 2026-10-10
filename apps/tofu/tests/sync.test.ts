import { expect, test } from "bun:test";
import { createSyncChangesPlugin } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { createTofuSync } from "../src/api/sync";
import { fixture } from "./helpers";

test("live engine updates are recoverable through the Furin Sync journal", async () => {
  const context = await fixture(65_536, []);
  const sync = await createTofuSync(context.directory);
  try {
    const app = new Elysia().use(createSyncChangesPlugin(sync.options));
    await sync.publish();
    const response = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.reset).toBe(true);
    expect(page.cursor).not.toBe("0");
    await sync.publish();
    const next = await app.handle(
      new Request(`http://localhost/_furin/sync/changes?after=${page.cursor}`)
    );
    const nextPage = await next.json();
    expect(nextPage.reset).toBe(true);
    expect(nextPage.cursor).not.toBe(page.cursor);
  } finally {
    sync.close();
    await context.close();
  }
});
