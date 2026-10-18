import { expect, test } from "bun:test";
import { mkdir, rename, stat } from "node:fs/promises";
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
  const logPath = join(config.dataDir, "logs/app.jsonl");
  await mkdir(join(config.dataDir, "logs"), { recursive: true });
  await Bun.write(logPath, `${JSON.stringify({ previous: "x".repeat(5 * 1024 * 1024) })}\n`);
  await Bun.write(`${logPath}.1`, '{"archive":1}\n');
  await Bun.write(`${logPath}.2`, '{"archive":2}\n');
  await Bun.write(`${logPath}.3`, '{"archive":3}\n');
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
    const completed = await waitFor(
      async () => expectSuccess(await client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    expectSuccess(await client.torrents({ id }).pause.post({}));
    await rename(completed.savePath, join(context.directory, "original-storage"));
    await mkdir(completed.savePath);
    const failed = await client.torrents({ id }).repair.post({});
    expect(failed.status).toBe(409);
    const failure = await client.torrents.post({
      paused: true,
      source: `${provider.url}?token=${secret}`,
    });
    expect(failure.status).toBeGreaterThanOrEqual(400);
    await host.stop();
    const first = await readLogRecords(logPath);
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
    expect(await Bun.file(logPath).text()).not.toContain(secret);
    expect(await Bun.file(`${logPath}.2`).text()).toBe('{"archive":1}\n');
    expect(await Bun.file(`${logPath}.3`).text()).toBe('{"archive":2}\n');
    expect((await stat(logPath)).size).toBeLessThan(5 * 1024 * 1024);
    if (process.platform !== "win32") {
      expect((await stat(logPath)).mode % 0o1000).toBe(0o600);
      expect((await stat(join(config.dataDir, "logs"))).mode % 0o1000).toBe(0o700);
    }
    host = launchServer(config);
    client = treaty<Api>(await host.ready()).api;
    expect((await client.health.get()).status).toBe(200);
    await host.stop();
    const restored = await readLogRecords(logPath);
    expect(restored.filter((record) => record.operation === "startup")).toHaveLength(2);
    expect(restored.filter((record) => record.operation === "shutdown")).toHaveLength(2);
  } finally {
    provider.stop(true);
    await host.stop();
    await context.close();
  }
}, 30_000);
