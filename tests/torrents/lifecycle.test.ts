import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";
import type { TorrentLifecycleApp } from "../helpers/torrent-lifecycle-server";

test("the torrent runtime transfers real bytes and releases its worker on shutdown", async () => {
  await using source = await peer();
  await using directory = await application();
  let port: number | undefined;
  const child = Bun.spawn([process.execPath, "tests/helpers/torrent-lifecycle-server.ts"], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: join(directory.directory, "tofu.sqlite"),
      FURIN_APP_DATA_DIR: directory.directory,
    },
    ipc(message: { port: number }) {
      port = message.port;
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  });
  const output = (async () => {
    const streams = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return streams.join("\n");
  })();
  await waitFor(
    async () => {
      if (child.exitCode !== null) {
        throw new Error(`Torrent startup failed.\n${await output}`);
      }
      return port;
    },
    (value) => value !== undefined
  );
  const client = treaty<TorrentLifecycleApp>(`http://127.0.0.1:${port}`);
  expect(success(await client.state.get()).torrents).toHaveLength(0);
  expect((await client.torrents({ id: source.id }).get()).status).toBe(404);
  expect(success(await client.torrents.post({ source: source.magnet })).id).toBe(source.id);
  const completed = await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expect(completed.downloaded).toBe(source.bytes.length);
  expect(
    new Uint8Array(
      await Bun.file(join(directory.directory, "downloads", source.filename)).arrayBuffer()
    )
  ).toEqual(new Uint8Array(source.bytes));

  using deadline = new DisposableStack();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
  deadline.defer(() => clearTimeout(timeout));
  child.kill("SIGTERM");
  expect(await child.exited, await output).toBe(0);
});

test("failed torrent restoration releases the worker without opening the application", async () => {
  await using directory = await application();
  const child = Bun.spawn([process.execPath, "tests/helpers/failed-torrent-startup.ts"], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: join(directory.directory, "tofu.sqlite"),
      FURIN_APP_DATA_DIR: directory.directory,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 8000);
  cleanup.defer(() => clearTimeout(deadline));
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(stdout).toContain("Failed torrent startup released its resources");
});
