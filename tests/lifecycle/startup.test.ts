import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";

const invalidJson = /JSON|Parse/i;

test("a failed service initialization releases resources before the process exits", async () => {
  await using app = await application();
  const dataDir = join(app.directory, "state");
  await mkdir(dataDir, { recursive: true });
  const corruptState = join(dataDir, "release-access.json");
  await Bun.write(corruptState, "{");

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
  const deadline = setTimeout(() => child.kill(), 15_000);
  cleanup.defer(() => clearTimeout(deadline));
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toMatch(invalidJson);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(stderr).toContain("SyntaxError");
  expect(stdout).toContain("Failed startup released the database and torrent worker");

  await rm(corruptState);
  const server = await app.start();
  expect(success(await server.client.session.get()).server.id).toBeTruthy();
});
