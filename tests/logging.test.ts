import { expect, test } from "bun:test";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../src/api";
import { resolveInstanceConfig } from "../src/api/lib/instance";
import { readLogRecords } from "./helpers/logs";
import { expectSuccess } from "./helpers/problem";
import { launchServer } from "./helpers/server-process";
import { fixture, waitFor } from "./helpers/torrent";

test("application logs preserve worker storage errors, redact credentials and survive restart with bounded rotation", async () => {
  const context = await fixture(128 * 1024, []);
  const secret = "private-credential-must-not-be-logged";
  const config = resolveInstanceConfig({
    dataDir: join(context.directory, "logged-state"),
    desktop: false,
    downloadPath: join(context.directory, "logged-downloads", `token=${secret}`),
    homeDir: context.directory,
    platform: process.platform,
    port: "0",
    profile: "dev",
  });
  const logDirectory = join(config.dataDir, "logs");
  const logDate = new Date().toISOString().slice(0, 10);
  const logPath = join(logDirectory, `${logDate}.jsonl`);
  await mkdir(logDirectory, { recursive: true });
  await Bun.write(logPath, `${JSON.stringify({ previous: "x".repeat(5 * 1024 * 1024) })}\n`);
  await Bun.write(join(logDirectory, "2000-01-01.jsonl"), '{"archive":1}\n');
  await Bun.write(join(logDirectory, "2000-01-02.jsonl"), '{"archive":2}\n');
  await Bun.write(join(logDirectory, "2000-01-03.jsonl"), '{"archive":3}\n');
  let host = launchServer(config);
  const provider = Bun.serve({
    fetch: () =>
      new Response(
        `Authorization: Bearer ${secret}; token=${secret}; https://user:${secret}@example.test/failure?api_key=${secret}`,
        { status: 500 }
      ),
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    let client = treaty<Api>(await host.ready()).api;
    expect((await client.desktop.logs.open.post()).status).toBe(409);
    const { id } = expectSuccess(
      await client.torrents.post({ paused: false, source: context.magnet })
    );
    await waitFor(
      async () => expectSuccess(await client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    const { savePath } = expectSuccess(await client.torrents({ id }).host.get());
    expectSuccess(await client.torrents({ id }).pause.post({}));
    await rename(savePath, join(context.directory, "original-storage"));
    await mkdir(savePath);
    const failed = await client.torrents({ id }).repair.post({});
    expect(failed.status).toBe(409);
    const failure = await client.torrents.post({
      paused: true,
      source: `${provider.url}?token=${secret}`,
    });
    expect(failure.status).toBeGreaterThanOrEqual(400);
    await host.stop();
    const first = await readLogRecords(logDirectory);
    expect(first).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "application", operation: "startup" }),
        expect.objectContaining({ component: "application", operation: "ready" }),
        expect.objectContaining({ component: "application", operation: "shutdown" }),
        expect.objectContaining({
          component: "storage",
          context: expect.objectContaining({
            savePath: expect.stringContaining("token=[redacted]"),
            torrentId: id,
          }),
          error: expect.objectContaining({
            code: "ENODEV",
            expected: expect.objectContaining({ ino: expect.any(Number) }),
            message: "The original torrent destination is unavailable",
            observed: expect.objectContaining({ ino: expect.any(Number) }),
            stack: expect.any(String),
          }),
          operation: "access",
        }),
      ])
    );
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(first).not.toContainEqual(expect.objectContaining({ operation: "response" }));
    expect(await Bun.file(join(logDirectory, "2000-01-01.jsonl")).exists()).toBe(false);
    expect(await Bun.file(join(logDirectory, "2000-01-02.jsonl")).text()).toBe('{"archive":2}\n');
    expect(await Bun.file(join(logDirectory, "2000-01-03.jsonl")).text()).toBe('{"archive":3}\n');
    const files = (await readdir(logDirectory)).filter((file) => file.endsWith(".jsonl"));
    expect(files).toHaveLength(4);
    const activePath = join(logDirectory, `${logDate}.1.jsonl`);
    expect((await stat(activePath)).size).toBeLessThan(5 * 1024 * 1024);
    if (process.platform !== "win32") {
      const fileStats = await Promise.all(files.map((file) => stat(join(logDirectory, file))));
      for (const file of fileStats) {
        expect(file.mode % 0o1000).toBe(0o600);
      }
      expect((await stat(logDirectory)).mode % 0o1000).toBe(0o700);
    }
    host = launchServer(config);
    client = treaty<Api>(await host.ready()).api;
    expect((await client.health.get()).status).toBe(200);
    await host.stop();
    const restored = await readLogRecords(logDirectory);
    expect(restored.filter((record) => record.operation === "startup")).toHaveLength(2);
    expect(restored.filter((record) => record.operation === "shutdown")).toHaveLength(2);
  } finally {
    provider.stop(true);
    await host.stop();
    await context.close();
  }
}, 30_000);
