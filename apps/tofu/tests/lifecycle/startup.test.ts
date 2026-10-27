import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";

const invalidJson = /JSON|Parse/i;

test("a failed service initialization releases resources before the process exits", async () => {
  await using app = await application();
  const dataDir = join(app.directory, "state");

  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      "./tests/helpers/preload.ts",
      "tests/helpers/failed-startup.ts",
      "0",
      app.directory,
    ],
    {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        DATABASE_URL: join(dataDir, "tofu.sqlite"),
        FURIN_APP_DATA_DIR: undefined,
        NODE_ENV: "development",
        TOFU_DISCOVERY: "0",
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  using cleanup = new DisposableStack();
  cleanup.defer(() => child.kill());
  const deadline = setTimeout(() => child.kill(), 20_000);
  cleanup.defer(() => clearTimeout(deadline));
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toMatch(invalidJson);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(stderr).toContain("SchemaError");
  expect(stdout).toContain("Failed startup released the database and torrent worker");

  {
    using database = new Database(join(dataDir, "tofu.sqlite"));
    database.query("DELETE FROM releases WHERE id = ?").run("failed-startup");
  }
  const server = await app.start();
  expect(success(await server.client.session.get()).server.id).toBeTruthy();
}, 60_000);
