import { expect, test } from "bun:test";
import { createSyncChangesPlugin, furinSync } from "@teyik0/furin/sync";
import { sql } from "drizzle-orm";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { Elysia } from "elysia";
import { publishEngineChanges } from "../src/api/lib/lifecycle";
import { openTestDatabase } from "./database";
import { fixture } from "./helpers";

const counter = sqliteTable("sync_counter", { value: integer().notNull() });

test("the shared journal preserves replay responses and changes across restarts", async () => {
  const context = await fixture(1024, []);
  let current = await openTestDatabase(context.directory);
  const request = () =>
    new Request("http://localhost/replay", {
      headers: { "idempotency-key": "persistent-write" },
      method: "POST",
    });
  const original = new Elysia()
    .use(furinSync(current.options))
    .use(createSyncChangesPlugin(current.options))
    .post("/replay", { sync: { invalidate: { path: "/", type: "layout" } } }, ({ mutation }) =>
      mutation(() => ({ count: 1 }))
    );
  try {
    expect(await (await original.handle(request())).json()).toEqual({ count: 1 });
    const page = await (
      await original.handle("http://localhost/_furin/sync/changes?after=0")
    ).json();
    await current.close();
    current = await openTestDatabase(context.directory);
    const reopened = new Elysia()
      .use(furinSync(current.options))
      .use(createSyncChangesPlugin(current.options))
      .post("/replay", { sync: { invalidate: { path: "/", type: "layout" } } }, ({ mutation }) =>
        mutation(() => ({ count: 100 }))
      );
    expect(await (await reopened.handle(request())).json()).toEqual({ count: 1 });
    expect(
      await (await reopened.handle("http://localhost/_furin/sync/changes?after=0")).json()
    ).toEqual(page);
    await publishEngineChanges(current.options);
    const latest = await (
      await reopened.handle("http://localhost/_furin/sync/changes?after=0")
    ).json();
    await current.close();
    current = await openTestDatabase(context.directory);
    const restarted = new Elysia().use(createSyncChangesPlugin(current.options));
    expect(
      await (await restarted.handle("http://localhost/_furin/sync/changes?after=0")).json()
    ).toEqual(latest);
  } finally {
    await current.close();
    await context.close();
  }
});

test("SQL mutations commit with the journal and replay without repeating their writes", async () => {
  const context = await fixture(1024, []);
  try {
    const app = new Elysia()
      .use(furinSync(context.sync.options))
      .use(createSyncChangesPlugin(context.sync.options))
      .post("/counter", { sync: { invalidate: { path: "/", type: "layout" } } }, ({ mutation }) =>
        mutation((tx) => {
          tx.run(sql`CREATE TABLE IF NOT EXISTS sync_counter (value INTEGER NOT NULL)`);
          tx.insert(counter).values({ value: 1 }).run();
          return { count: tx.select().from(counter).all().length };
        })
      );
    const request = (key: string) =>
      new Request("http://localhost/counter", {
        headers: { "idempotency-key": key },
        method: "POST",
      });
    const initial = await app.handle(request("first"));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ count: 1 });
    const page = await (await app.handle("http://localhost/_furin/sync/changes?after=0")).json();
    expect(page.cursor).not.toBe("0");
    const replay = await app.handle(request("first"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ count: 1 });
    expect(await (await app.handle("http://localhost/_furin/sync/changes?after=0")).json()).toEqual(
      page
    );
    expect(await (await app.handle(request("second"))).json()).toEqual({ count: 2 });
  } finally {
    await context.close();
  }
});

test("failed SQL mutations roll back their writes and leave the journal cursor unchanged", async () => {
  const context = await fixture(1024, []);
  try {
    const app = new Elysia()
      .use(furinSync(context.sync.options))
      .use(createSyncChangesPlugin(context.sync.options))
      .post(
        "/counter/:operation",
        { sync: { invalidate: { path: "/", type: "layout" } } },
        ({ mutation, params }) =>
          mutation((tx) => {
            tx.run(sql`CREATE TABLE IF NOT EXISTS sync_counter (value INTEGER NOT NULL)`);
            tx.insert(counter).values({ value: 1 }).run();
            if (params.operation === "reject") {
              throw new Error("Mutation rejected");
            }
            return { count: tx.select().from(counter).all().length };
          })
      );
    const request = (operation: string, key: string) =>
      new Request(`http://localhost/counter/${operation}`, {
        headers: { "idempotency-key": key },
        method: "POST",
      });
    expect(await (await app.handle(request("save", "first"))).json()).toEqual({ count: 1 });
    const page = await (await app.handle("http://localhost/_furin/sync/changes?after=0")).json();
    expect((await app.handle(request("reject", "failed"))).status).toBe(500);
    expect(await (await app.handle("http://localhost/_furin/sync/changes?after=0")).json()).toEqual(
      page
    );
    expect(await (await app.handle(request("save", "second"))).json()).toEqual({ count: 2 });
  } finally {
    await context.close();
  }
});

test("live engine updates are recoverable through the Furin Sync journal", async () => {
  const context = await fixture(65_536, []);
  const sync = await openTestDatabase(context.directory);
  try {
    const app = new Elysia().use(createSyncChangesPlugin(sync.options));
    await publishEngineChanges(sync.options);
    const response = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.reset).toBe(true);
    expect(page.cursor).not.toBe("0");
    await publishEngineChanges(sync.options);
    const next = await app.handle(
      new Request(`http://localhost/_furin/sync/changes?after=${page.cursor}`)
    );
    const nextPage = await next.json();
    expect(nextPage.reset).toBe(true);
    expect(nextPage.cursor).not.toBe(page.cursor);
  } finally {
    await sync.close();
    await context.close();
  }
});

test("the journal preserves live changes across database restarts", async () => {
  const context = await fixture(1024, []);
  let sync = await openTestDatabase(context.directory);
  try {
    const app = new Elysia().use(createSyncChangesPlugin(sync.options));
    await publishEngineChanges(sync.options);
    const page = await (await app.handle("http://localhost/_furin/sync/changes?after=0")).json();
    await sync.close();
    sync = await openTestDatabase(context.directory);
    const restarted = new Elysia().use(createSyncChangesPlugin(sync.options));
    expect(
      await (await restarted.handle("http://localhost/_furin/sync/changes?after=0")).json()
    ).toEqual(page);
    await publishEngineChanges(sync.options);
    const next = await (
      await restarted.handle(`http://localhost/_furin/sync/changes?after=${page.cursor}`)
    ).json();
    expect(next.reset).toBe(true);
    expect(next.cursor).not.toBe(page.cursor);
  } finally {
    await sync.close();
    await context.close();
  }
});
