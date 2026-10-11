import { expect, test } from "bun:test";
import { chmod, mkdir, rename, rm, symlink, truncate } from "node:fs/promises";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Torrent, TorrentOptions } from "webtorrent";
import { WorkerTorrentEngine } from "../src/api/modules/torrents/worker-client";
import type { TorrentDetail } from "../src/types";
import { createTestApi } from "./helpers/application";
import { expectDefined, expectSuccess } from "./helpers/problem";
import { fixture, network, waitFor } from "./helpers/torrent";

test.skipIf(process.platform === "win32")(
  "an inaccessible root alias retains its physical file reservation",
  async () => {
    const context = await fixture(128 * 1024, []);
    const other = await fixture(128 * 1024, []);
    const restricted = join(context.directory, "restricted");
    const physical = join(context.directory, "downloads");
    try {
      await mkdir(restricted);
      const alias = join(restricted, "alias");
      await symlink(physical, alias);
      const first = expectSuccess(
        await context.client.torrents.post({
          downloadPath: alias,
          paused: false,
          source: context.magnet,
        })
      );
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: first.id }).get()),
        (detail) => detail.status === "seeding"
      );
      await chmod(restricted, 0o000);
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: first.id }).get()),
        (detail) => detail.storageIssue?.kind === "permission-denied"
      );
      const second = expectSuccess(
        await context.client.torrents.post({
          downloadPath: physical,
          paused: false,
          source: other.magnet,
        })
      );
      const collision = await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: second.id }).get()),
        (detail) => detail.status === "error" || detail.status === "seeding"
      );
      expect(collision.status).toBe("error");
      expect(collision.error).toContain("already used");
      const path = join(physical, "source.bin");
      expect(Bun.SHA256.hash(await Bun.file(path).arrayBuffer(), "hex")).toBe(
        Bun.SHA256.hash(context.bytes, "hex")
      );
      expectSuccess(await context.client.torrents({ id: second.id }).delete({ deleteFiles: true }));
      expect(await Bun.file(path).exists()).toBe(true);
    } finally {
      await chmod(restricted, 0o700).catch(() => undefined);
      await Promise.all([context.close(), other.close()]);
    }
  },
  30_000
);
test.skipIf(process.platform === "win32")(
  "an inaccessible torrent destination does not block recovery in another folder",
  async () => {
    const context = await fixture(128 * 1024, []);
    const other = await fixture(128 * 1024, []);
    const protectedPath = join(context.directory, "protected");
    try {
      const protectedTorrent = expectSuccess(
        await context.client.torrents.post({
          downloadPath: protectedPath,
          paused: false,
          source: context.magnet,
        })
      );
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: protectedTorrent.id }).get()),
        (detail) => detail.status === "seeding"
      );
      const { id } = expectSuccess(
        await context.client.torrents.post({ paused: false, source: other.magnet })
      );
      const completed = await waitFor(
        async () => expectSuccess(await context.client.torrents({ id }).get()),
        (detail) => detail.status === "seeding"
      );
      await chmod(protectedPath, 0o000);
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: protectedTorrent.id }).get()),
        (detail) => detail.storageIssue?.kind === "permission-denied"
      );
      const path = join(completed.savePath, "source.bin");
      await rm(path);
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id }).get()),
        (detail) => detail.storageIssue !== null
      );
      expect((await context.client.torrents({ id }).repair.post({})).status).toBe(200);
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id }).get()),
        (detail) => detail.status === "seeding"
      );
      expect(Bun.SHA256.hash(await Bun.file(path).arrayBuffer(), "hex")).toBe(
        Bun.SHA256.hash(other.bytes, "hex")
      );
    } finally {
      await chmod(protectedPath, 0o700).catch(() => undefined);
      await Promise.all([context.close(), other.close()]);
    }
  },
  30_000
);
test("concurrent location cannot claim files already being located by another torrent", async () => {
  const context = await fixture(128 * 1024, []);
  const other = await fixture(128 * 1024, []);
  try {
    const first = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const second = expectSuccess(
      await context.client.torrents.post({
        downloadPath: join(context.directory, "second"),
        paused: false,
        source: other.magnet,
      })
    );
    const firstCompleted = structuredClone(
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: first.id }).get()),
        (detail) => detail.status === "seeding"
      )
    );
    const completed = structuredClone(
      await waitFor(
        async () => expectSuccess(await context.client.torrents({ id: second.id }).get()),
        (detail) => detail.status === "seeding"
      )
    );
    const target = join(context.directory, "located");
    await Bun.write(join(target, "source.bin"), context.bytes);
    const responses = await Promise.all([
      context.client.torrents({ id: first.id }).locate.post({ downloadPath: target }),
      context.client.torrents({ id: second.id }).locate.post({ downloadPath: target }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const rejected = responses[0]?.status === 409 ? firstCompleted : completed;
    expect(expectSuccess(await context.client.torrents({ id: rejected.id }).get()).savePath).toBe(
      rejected.savePath
    );
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id: rejected.id }).get()),
      (detail) => detail.status === "seeding"
    );
    expect(Bun.SHA256.hash(await Bun.file(join(target, "source.bin")).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    expect(
      Bun.SHA256.hash(await Bun.file(join(completed.savePath, "source.bin")).arrayBuffer(), "hex")
    ).toBe(Bun.SHA256.hash(other.bytes, "hex"));
  } finally {
    await Promise.all([context.close(), other.close()]);
  }
}, 30_000);
test("deleting a completed file stops sharing and requires explicit recovery", async () => {
  const context = await fixture(256 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const completed = await waitFor(read, (detail) => detail.status === "seeding");
    const path = join(completed.savePath, "source.bin");
    await rm(path);
    const blocked = await waitFor(read, (detail) => detail.status === "error");
    expect(blocked.storageIssue?.kind).toBe("missing-files");
    expect(blocked.storageIssue?.paths).toEqual(["source.bin"]);
    expect(blocked.downloadSpeed).toBe(0);
    expect(blocked.uploadSpeed).toBe(0);
    expect(blocked.peers).toBe(0);
    expect(blocked.progress).toBeNull();
    expect(blocked.downloaded).toBeNull();
    expect(blocked.eta).toBeNull();
    expect((await context.client.torrents({ id }).resume.post({})).status).toBe(409);
    expect(await Bun.file(path).exists()).toBe(false);
  } finally {
    await context.close();
  }
}, 30_000);
test("repair refuses oversized files without clearing the problem or deleting extra data", async () => {
  const context = await fixture(128 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const completed = await waitFor(read, (detail) => detail.status === "seeding");
    const path = join(completed.savePath, "source.bin");
    const expanded = Buffer.concat([context.bytes, Buffer.from("Keep this extra data")]);
    await Bun.write(path, expanded);
    const blocked = await waitFor(read, (detail) => detail.storageIssue !== null);
    expect(blocked.storageIssue?.kind).toBe("modified-files");
    expect((await context.client.torrents({ id }).repair.post({})).status).toBe(409);
    expect((await read()).storageIssue?.kind).toBe("modified-files");
    expect((await read()).status).toBe("error");
    expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(new Uint8Array(expanded));
  } finally {
    await context.close();
  }
}, 30_000);
test.skipIf(process.platform === "win32")(
  "revoked file permissions stop sharing and retry reuses data after access returns",
  async () => {
    const context = await fixture(128 * 1024, []);
    const path = join(context.directory, "downloads/source.bin");
    try {
      const { id } = expectSuccess(
        await context.client.torrents.post({ paused: false, source: context.magnet })
      );
      const read = async () =>
        expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
      const completed = await waitFor(read, (detail) => detail.status === "seeding");
      await chmod(path, 0o000);
      const blocked = await waitFor(read, (detail) => detail.storageIssue !== null);
      expect(blocked.storageIssue?.kind).toBe("permission-denied");
      expect((await context.client.torrents({ id }).repair.post({})).status).toBe(409);
      await chmod(path, 0o600);
      expect((await context.client.torrents({ id }).repair.post({})).status).toBe(200);
      await waitFor(read, (detail) => detail.status === "seeding");
      expect((await read()).received - completed.received).toBeLessThan(completed.pieceLength);
      expect(Bun.SHA256.hash(await Bun.file(path).arrayBuffer(), "hex")).toBe(
        Bun.SHA256.hash(context.bytes, "hex")
      );
    } finally {
      await chmod(path, 0o600).catch(() => undefined);
      await context.close();
    }
  },
  30_000
);
test("multifile repair preserves intact files and ignores skipped and empty files", async () => {
  const context = await fixture(65_536, []);
  try {
    const source = join(context.directory, "collection");
    await Bun.write(join(source, "first.bin"), context.bytes);
    await Bun.write(join(source, "missing.bin"), context.bytes);
    await Bun.write(join(source, "skip.bin"), context.bytes);
    await Bun.write(join(source, "empty.bin"), new Uint8Array());
    const seedOptions: TorrentOptions & { pieceLength: number } = {
      announce: [],
      pieceLength: 16_384,
    };
    const seed = await new Promise<Torrent>((resolve) =>
      context.seeder.seed(source, seedOptions, resolve)
    );
    const { id } = expectSuccess(
      await context.client.torrents.file.post({
        file: new File([new Uint8Array(seed.torrentFile)], "collection.torrent"),
        paused: "true",
      })
    );
    const skipped = expectSuccess(await context.client.torrents({ id }).get()).files.find(
      (file) => file.path === "collection/skip.bin"
    );
    expect(skipped).toBeDefined();
    expectSuccess(
      await context.client
        .torrents({ id })
        .files({ index: String(skipped?.index) })
        .put({ priority: "skip" })
    );
    expectSuccess(await context.client.torrents({ id }).resume.post({}));
    expectSuccess(
      await context.client
        .torrents({ id })
        .peers.post({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const completed = await waitFor(read, (detail) =>
      detail.files.filter((file) => file.priority !== "skip").every((file) => file.progress === 1)
    );
    const first = join(completed.savePath, "collection/first.bin");
    const missing = join(completed.savePath, "collection/missing.bin");
    const unrelated = join(completed.savePath, "collection/notes.txt");
    await Bun.write(unrelated, "Keep this file");
    await Bun.sleep(1200);
    expect((await read()).storageIssue).toBeNull();
    expect(await Bun.file(join(completed.savePath, "collection/skip.bin")).exists()).toBe(false);
    await rm(missing);
    const blocked = await waitFor(read, (detail) => detail.storageIssue !== null);
    expect(blocked.storageIssue?.paths).toEqual(["collection/missing.bin"]);
    expect(Bun.SHA256.hash(await Bun.file(first).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    expect((await context.client.torrents({ id }).repair.post({})).status).toBe(200);
    await waitFor(read, (detail) =>
      detail.files.filter((file) => file.priority !== "skip").every((file) => file.progress === 1)
    );
    const received = (await read()).received - completed.received;
    expect(received).toBeGreaterThanOrEqual(context.bytes.length);
    expect(received).toBeLessThan(context.bytes.length + seed.pieceLength);
    expect(Bun.SHA256.hash(await Bun.file(missing).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    expect(await Bun.file(unrelated).text()).toBe("Keep this file");
    expect(await Bun.file(join(completed.savePath, "collection/skip.bin")).exists()).toBe(false);
    await truncate(first, 0);
    await rm(missing);
    const firstIndex = completed.files.find((file) => file.path === "collection/first.bin")?.index;
    expectDefined(firstIndex);
    expect(
      (await context.client.torrents({ id }).files({ index: firstIndex }).content.get()).status
    ).toBe(404);
    const mixed = await read();
    expect(mixed.storageIssue?.paths.toSorted()).toEqual([
      "collection/first.bin",
      "collection/missing.bin",
    ]);
  } finally {
    await context.close();
  }
}, 30_000);
test("adding into unavailable storage never recreates a missing destination, even for duplicates", async () => {
  const context = await fixture(128 * 1024, []);
  const other = await fixture(128 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const completed = await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    const path = completed.savePath;
    await rename(path, join(context.directory, "offline"));
    expect(
      (await context.client.torrents.post({ paused: false, source: context.magnet })).status
    ).toBe(409);
    expect(
      (await context.client.torrents.post({ paused: false, source: other.magnet })).status
    ).toBe(409);
    expect(await Bun.file(path).exists()).toBe(false);
  } finally {
    await Promise.all([context.close(), other.close()]);
  }
}, 30_000);
test("buffered blocks before the first piece is written are healthy across pause and verification", async () => {
  const context = await fixture(512 * 1024, []);
  try {
    const seedOptions: TorrentOptions & { pieceLength: number } = {
      announce: [],
      pieceLength: 256 * 1024,
    };
    const seed = await new Promise<Torrent>((resolve) =>
      context.seeder.seed(join(context.directory, "source.bin"), seedOptions, resolve)
    );
    expectSuccess(await context.client.settings.patch({ downloadLimit: 64 * 1024 }));
    const { id } = expectSuccess(
      await context.client.torrents.post({
        paused: false,
        source: `${seed.magnetURI}&x.pe=127.0.0.1:${context.seeder.torrentPort}`,
      })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    await waitFor(read, (detail) => detail.received > 0);
    await Bun.sleep(1200);
    expect((await read()).storageIssue).toBeNull();
    expect((await context.client.torrents({ id }).pause.post({})).status).toBe(200);
    expect((await context.client.torrents({ id }).resume.post({})).status).toBe(200);
    await waitFor(read, (detail) => detail.status !== "checking");
    expect((await read()).storageIssue).toBeNull();
    expect((await context.client.torrents({ id }).verify.post({})).status).toBe(200);
    expect((await read()).storageIssue).toBeNull();
    expectSuccess(await context.client.settings.patch({ downloadLimit: -1 }));
    await waitFor(read, (detail) => detail.status === "seeding");
    expect(
      Bun.SHA256.hash(
        await Bun.file(join(context.directory, "downloads/source.bin")).arrayBuffer(),
        "hex"
      )
    ).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  } finally {
    await context.close();
  }
}, 30_000);
test("verification immediately after deletion does not silently repair the download", async () => {
  const context = await fixture(128 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const completed = await waitFor(read, (detail) => detail.status === "seeding");
    const path = join(completed.savePath, "source.bin");
    await rm(path);
    expect((await context.client.torrents({ id }).verify.post({})).status).toBe(200);
    await Bun.sleep(1200);
    expect((await read()).storageIssue?.kind).toBe("missing-files");
    expect((await read()).status).toBe("error");
    expect((await read()).progress).toBe(0);
    expect(await Bun.file(path).exists()).toBe(false);
  } finally {
    await context.close();
  }
}, 30_000);
test.each(["missing-file", "missing-root", "replaced-root"])(
  "the isolated engine blocks %s at startup and persists the recovery requirement",
  async (mode) => {
    const context = await fixture(128 * 1024, []);
    const options = {
      dataDir: join(context.directory, "worker-state"),
      downloadPath: join(context.directory, "worker-downloads"),
      network,
    };
    let engine = await WorkerTorrentEngine.open(options);
    let api = await createTestApi(() => engine, context.sync.options);
    let client = treaty(api).api;
    try {
      const { id } = expectSuccess(
        await client.torrents.post({ paused: false, source: context.magnet })
      ) as { id: string };
      const read = async () => expectSuccess(await client.torrents({ id }).get()) as TorrentDetail;
      await waitFor(read, (detail) => detail.status === "seeding");
      await engine.close();
      if (mode === "missing-file") {
        await rm(join(options.downloadPath, "source.bin"));
      } else {
        await rename(options.downloadPath, join(context.directory, "original-storage"));
        if (mode === "replaced-root") {
          await mkdir(options.downloadPath);
          await Bun.write(join(options.downloadPath, "unrelated.txt"), "Keep this file");
        }
      }
      engine = await WorkerTorrentEngine.open(options);
      api = await createTestApi(() => engine, context.sync.options);
      client = treaty(api).api;
      const blocked = await read();
      expect(blocked.status).toBe("error");
      expect(blocked.storageIssue?.kind).toBe(
        mode === "missing-file" ? "missing-files" : "storage-unavailable"
      );
      expect(blocked.progress).toBeNull();
      expect((await client.torrents({ id }).resume.post({})).status).toBe(409);
      expect(await Bun.file(join(options.downloadPath, "source.bin")).exists()).toBe(false);
      await engine.close();
      engine = await WorkerTorrentEngine.open(options);
      api = await createTestApi(() => engine, context.sync.options);
      client = treaty(api).api;
      expect((await read()).storageIssue?.kind).toBe(blocked.storageIssue?.kind);
      if (mode === "missing-file") {
        expect((await client.torrents({ id }).repair.post({})).status).toBe(200);
      } else {
        const located = await client
          .torrents({ id })
          .locate.post({ downloadPath: join(context.directory, "original-storage") });
        expect(located.status).toBe(200);
      }
      await waitFor(read, (detail) => detail.status === "seeding");
      if (mode === "replaced-root") {
        expect(await Bun.file(join(options.downloadPath, "unrelated.txt")).text()).toBe(
          "Keep this file"
        );
      }
    } finally {
      await engine.close();
      await context.close();
    }
  },
  30_000
);
test("locating moved files verifies and reuses them without moving or downloading data", async () => {
  const context = await fixture(256 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const completed = await waitFor(read, (detail) => detail.status === "seeding");
    const target = join(context.directory, "relocated");
    await rename(completed.savePath, target);
    await waitFor(read, (detail) => detail.storageIssue !== null);
    const response = await context.client.torrents({ id }).locate.post({ downloadPath: target });
    expect(response.status).toBe(200);
    await waitFor(read, (detail) => detail.status === "seeding");
    const located = await read();
    expect(located.storageIssue).toBeNull();
    expect(located.savePath).toBe(target);
    expect(located.received - completed.received).toBeLessThan(completed.pieceLength);
    expect(await Bun.file(join(completed.savePath, "source.bin")).exists()).toBe(false);
    expect(Bun.SHA256.hash(await Bun.file(join(target, "source.bin")).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
}, 30_000);
test("same-size external changes require verification before sharing resumes", async () => {
  const context = await fixture(256 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const completed = await waitFor(read, (detail) => detail.status === "seeding");
    await Bun.sleep(1200);
    const path = join(completed.savePath, "source.bin");
    await Bun.write(path, new Uint8Array(context.bytes.length));
    const blocked = await waitFor(read, (detail) => detail.status === "error");
    expect(blocked.storageIssue?.kind).toBe("modified-files");
    expect((await context.client.torrents({ id }).verify.post({})).status).toBe(200);
    expect((await read()).storageIssue?.kind).toBe("modified-files");
    expect((await read()).progress).toBe(0);
    expect((await context.client.torrents({ id }).repair.post({})).status).toBe(200);
    await waitFor(read, (detail) => detail.status === "seeding");
    expect(Bun.SHA256.hash(await Bun.file(path).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
}, 30_000);
test("deleting a file during a real transfer stops writing until explicit repair", async () => {
  const context = await fixture(2 * 1024 * 1024, []);
  try {
    expectSuccess(await context.client.settings.patch({ downloadLimit: 256 * 1024 }));
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const downloading = await waitFor(
      read,
      (detail) => (detail.downloaded ?? 0) > 0 && detail.progress !== 1
    );
    const path = join(downloading.savePath, "source.bin");
    await rm(path);
    const blocked = await waitFor(read, (detail) => detail.status === "error");
    expect(blocked.storageIssue?.kind).toBe("missing-files");
    const { received } = blocked;
    await Bun.sleep(1200);
    expect((await read()).received).toBe(received);
    expect(await Bun.file(path).exists()).toBe(false);
    expectSuccess(await context.client.settings.patch({ downloadLimit: -1 }));
    expect((await context.client.torrents({ id }).repair.post({})).status).toBe(200);
    await waitFor(read, (detail) => detail.status === "seeding");
    expect(Bun.SHA256.hash(await Bun.file(path).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
}, 30_000);
test("an unavailable destination is never recreated and retry waits for the original storage", async () => {
  const context = await fixture(256 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const completed = await waitFor(read, (detail) => detail.status === "seeding");
    const disconnected = join(context.directory, "disconnected");
    await rename(completed.savePath, disconnected);
    const blocked = await waitFor(read, (detail) => detail.storageIssue !== null);
    expect(blocked.storageIssue?.kind).toBe("storage-unavailable");
    expect((await context.client.torrents({ id }).repair.post({})).status).toBe(409);
    expect(await Bun.file(join(completed.savePath, "source.bin")).exists()).toBe(false);
    await rename(disconnected, completed.savePath);
    expect((await context.client.torrents({ id }).repair.post({})).status).toBe(200);
    await waitFor(read, (detail) => detail.status === "seeding");
    expect((await read()).received - completed.received).toBeLessThan(completed.pieceLength);
    expect(
      Bun.SHA256.hash(await Bun.file(join(completed.savePath, "source.bin")).arrayBuffer(), "hex")
    ).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  } finally {
    await context.close();
  }
}, 30_000);
test("truncated completed data is blocked before file access and repair respects a user pause", async () => {
  const context = await fixture(256 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const completed = await waitFor(read, (detail) => detail.status === "seeding");
    expectSuccess(await context.client.torrents({ id }).pause.post({}));
    const path = join(completed.savePath, "source.bin");
    await truncate(path, 0);
    const response = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(response.status).toBe(409);
    const blocked = await waitFor(read, (detail) => detail.storageIssue !== null);
    expect(blocked.status).toBe("paused");
    expect(blocked.storageIssue?.kind).toBe("modified-files");
    expect((await context.client.torrents({ id }).repair.post({})).status).toBe(200);
    expect((await read()).status).toBe("paused");
    expect((await read()).progress).toBe(0);
    expect((await read()).storageIssue).toBeNull();
    expect((await context.client.torrents({ id }).resume.post({})).status).toBe(200);
    await waitFor(read, (detail) => detail.status === "seeding");
    expect(Bun.SHA256.hash(await Bun.file(path).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
}, 30_000);
test("explicit repair verifies remaining data and downloads missing bytes from a real peer", async () => {
  const context = await fixture(256 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = async () =>
      expectSuccess(await context.client.torrents({ id }).get()) as TorrentDetail;
    const completed = await waitFor(read, (detail) => detail.status === "seeding");
    const path = join(completed.savePath, "source.bin");
    await rm(path);
    await waitFor(read, (detail) => detail.storageIssue !== null);
    const repaired = await context.client.torrents({ id }).repair.post({});
    expect(repaired.status).toBe(200);
    const restored = await waitFor(read, (detail) => detail.status === "seeding");
    expect(restored.storageIssue).toBeNull();
    expect(restored.progress).toBe(1);
    expect(Bun.SHA256.hash(await Bun.file(path).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
}, 30_000);
