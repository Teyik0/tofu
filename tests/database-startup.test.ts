import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { databaseMigrationsPlugin } from "../scripts/database-migrations";
import { assertDatabaseReady, openDatabase } from "../src/api/lib/db";
import { AutomationService } from "../src/api/modules/automation/service";
import { pluginEndpoints } from "../src/api/modules/plugins/service";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import { automationRules } from "../src/db/schema";
import { fixture, network } from "./helpers";

test("automation shutdown finalizes owned prepared statements and releases database files", async () => {
  const context = await fixture(1024, []);
  const directory = join(context.directory, "automation");
  const service = await AutomationService.open({
    dataDir: directory,
    endpoints: pluginEndpoints,
    engine: () => context.engine,
    now: Date.now,
  });
  try {
    const statement = service.db.select().from(automationRules).prepare();
    expect(statement.all()).toEqual([]);
    await service.close();
    expect(() => statement.all()).toThrow("Database has closed");
    await rm(directory, { recursive: true });
  } finally {
    await service.close();
    await context.close();
  }
});

test("automation shutdown leaves shared statements usable until the database owner closes", async () => {
  const context = await fixture(1024, []);
  const service = await AutomationService.open(
    {
      dataDir: join(context.directory, "state"),
      endpoints: pluginEndpoints,
      engine: () => context.engine,
      now: Date.now,
    },
    context.sync.db
  );
  const statement = service.db.select().from(automationRules).prepare();
  try {
    await service.close();
    expect(statement.all()).toEqual([]);
  } finally {
    await service.close();
    await context.close();
  }
  expect(() => statement.all()).toThrow("Database has closed");
  expect(await Bun.file(join(context.directory, "state", "feeds.sqlite")).exists()).toBe(false);
});

test("database migrations preserve current settings and torrents across repeated startup", async () => {
  const context = await fixture(4096, []);
  const directory = join(context.directory, "existing");
  let engine: TorrentEngine | undefined;
  try {
    await mkdir(directory);
    const database = new Database(join(directory, "feeds.sqlite"), { create: true });
    try {
      database.run("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      database.run("INSERT INTO config (key, value) VALUES (?, ?)", [
        "settings",
        JSON.stringify({ downloadLimit: 8192, theme: "dark" }),
      ]);
    } finally {
      database.close();
    }
    const options = {
      dataDir: directory,
      downloadPath: join(context.directory, "downloads"),
      network,
    };
    engine = await TorrentEngine.open(options);
    expect(engine.settings).toMatchObject({ downloadLimit: 8192, theme: "dark" });
    const torrent = await engine.add(context.magnet, { paused: true });
    await engine.close();
    engine = await TorrentEngine.open(options);
    expect(engine.settings).toMatchObject({ downloadLimit: 8192, theme: "dark" });
    expect(engine.detail(torrent.id).status).toBe("paused");
  } finally {
    await engine?.close();
    await context.close();
  }
});

test("database startup ignores old database files and preserves their contents", async () => {
  const context = await fixture(4096, []);
  const directory = join(context.directory, "database");
  const unusedPaths = ["tofu.sqlite", "sync.sqlite"].map((name) => join(directory, name));
  let reopened: TorrentEngine | undefined;
  let database: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    await mkdir(directory);
    await Promise.all(unusedPaths.map((path) => Bun.write(path, "Unused database contents")));
    database = await openDatabase(directory);
    const connection = database;
    expect(() => assertDatabaseReady(connection)).not.toThrow();
    reopened = await TorrentEngine.open({
      dataDir: directory,
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    expect(reopened.snapshot(null).torrents).toEqual([]);
    expect(await Promise.all(unusedPaths.map((path) => Bun.file(path).text()))).toEqual([
      "Unused database contents",
      "Unused database contents",
    ]);
  } finally {
    await reopened?.close();
    database?.$client.close(true);
    await context.close();
  }
});

test("a bundled database initializes outside the checkout and reopens successfully", async () => {
  const context = await fixture(4096, []);
  const output = join(context.directory, "bundle");
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/api/lib/db.ts")],
      naming: "database.js",
      outdir: output,
      plugins: [databaseMigrationsPlugin],
      target: "bun",
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        "const { openDatabase, assertDatabaseReady } = await import(process.argv[1]); const directory = process.argv[2]; const first = await openDatabase(directory); assertDatabaseReady(first); first.$client.close(true); const second = await openDatabase(directory); assertDatabaseReady(second); second.$client.close(true);",
        join(output, "database.js"),
        join(context.directory, "bundled-state"),
      ],
      { cwd: context.directory, stderr: "pipe", stdout: "pipe" }
    );
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
  } finally {
    await context.close();
  }
});
