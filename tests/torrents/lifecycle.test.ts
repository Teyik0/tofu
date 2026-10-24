import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";
import type { TorrentLifecycleApp } from "../helpers/torrent-lifecycle-server";

test.each(["shutdown", "crash", "watched-folder"] as const)(
  "the torrent runtime transfers real bytes and releases resources (%s)",
  async (ending) => {
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
        ({ port } = message);
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
    if (ending === "watched-folder") {
      await Promise.all([
        Bun.write(join(directory.directory, "downloads", "source.torrent"), source.torrentFile),
        Bun.write(
          join(directory.directory, "downloads", "incomplete.torrent"),
          "incomplete torrent"
        ),
      ]);
      await waitFor(
        async () => success(await client.state.get()).torrents,
        (torrents) => torrents.some((torrent) => torrent.id === source.id)
      );
      const peerAddress = new URL(source.magnet).searchParams.get("x.pe");
      assert.ok(peerAddress);
      success(await client.torrents({ id: source.id }).peers.post({ peer: peerAddress }));
    } else {
      expect(success(await client.torrents.post({ source: source.magnet })).id).toBe(source.id);
    }
    const completed = await waitFor(
      async () => success(await client.torrents({ id: source.id }).get()),
      (torrent) => torrent.status === "seeding"
    );
    expect(completed.downloaded).toBe(source.bytes.length);
    if (ending === "watched-folder") {
      expect(
        await Bun.file(join(directory.directory, "downloads", "source.torrent")).exists()
      ).toBe(false);
      expect(
        await Bun.file(join(directory.directory, "downloads", "incomplete.torrent")).text()
      ).toBe("incomplete torrent");
    }
    expect(
      new Uint8Array(
        await Bun.file(join(directory.directory, "downloads", source.filename)).arrayBuffer()
      )
    ).toEqual(new Uint8Array(source.bytes));

    if (ending === "shutdown") {
      const history = await waitFor(
        async () => success(await client.state.get()).history,
        (samples) => samples.some((sample) => sample.download > 0) && samples.at(-1)?.download === 0
      );
      expect(history.at(-1)).toMatchObject({ download: 0, upload: 0 });
    }

    if (ending === "crash") {
      success(await client.crash.post());
      expect((await client.torrents({ id: source.id }).get()).status).toBe(503);
      expect((await client.torrents({ id: source.id }).get()).status).toBe(503);
    }

    using deadline = new DisposableStack();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    deadline.defer(() => clearTimeout(timeout));
    child.send({ type: "shutdown" });
    expect(await child.exited, await output).toBe(0);
  }
);

test.each(["failed", "interrupted"] as const)(
  "%s torrent startup releases the worker without opening the application",
  async (scenario) => {
    await using directory = await application();
    const child = Bun.spawn([process.execPath, `tests/helpers/${scenario}-torrent-startup.ts`], {
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
    expect(stdout).toContain("torrent startup released its resources");
  }
);
