import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";

test("API requests emit one redacted event through direct Eden and HTTP", async () => {
  await using app = await application();
  const dataDir = join(app.directory, "state");
  const child = Bun.spawn([process.execPath, "tests/helpers/logging.ts"], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      FURIN_APP_DATA_DIR: undefined,
      TOFU_DATA_DIR: dataDir,
      TOFU_DISCOVERY: "0",
      TOFU_DOWNLOAD_DIR: app.downloadPath,
      TOFU_MODE: "server",
      TOFU_PORT: "0",
      TOFU_PROFILE: "dev",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  using cleanup = new DisposableStack();
  cleanup.defer(() => child.kill());
  const deadline = setTimeout(() => child.kill(), 20_000);
  cleanup.defer(() => clearTimeout(deadline));
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  const files = await Array.fromAsync(
    new Bun.Glob("*.jsonl").scan({ absolute: true, cwd: join(dataDir, "logs") })
  );
  const contents = (await Promise.all(files.map((file) => Bun.file(file).text()))).join("\n");
  expect(contents).not.toContain("private-logging-test-secret");
  const events = contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(events.filter((event) => event.path === "/api/health")).toMatchObject([
    { component: "api", status: 200 },
    { component: "api", status: 200 },
  ]);
  expect(events.filter((event) => event.path === "/api/torrents/missing-torrent")).toMatchObject([
    { status: 404 },
  ]);
  expect(events.filter((event) => event.path === "/api/auth/pair")).toMatchObject([
    { error: { message: "Request validation failed" }, level: "error", status: 422 },
  ]);
  expect(events.filter((event) => event.path === "/.well-known/tofu")).toHaveLength(1);
  expect(events.filter((event) => event.path === "/missing-logging-page")).toMatchObject([
    { status: 404 },
  ]);
});
