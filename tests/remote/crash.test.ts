import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { expectSuccess } from "../helpers/problem";
import { remoteServerFixture } from "../helpers/remote";
import { launchServer } from "../helpers/server-process";

test("a killed host reconciles a move before resuming peers, preserving the original bytes", async () => {
  await using context = await remoteServerFixture(64 * 1024 * 1024);
  const { api } = treaty<Api>(context.url);
  const { id } = expectSuccess(
    await api.torrents.file.post({
      destinationId: "default",
      file: new File([new Uint8Array(context.seed.torrentFile)], "show.torrent"),
      paused: "false",
    })
  );
  expectSuccess(
    await api.torrents({ id }).peers.post({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
  );
  await context.complete(id);
  const target = join(context.directory, "moved");
  const database = new Database(join(context.config.dataDir, "feeds.sqlite"), { readonly: true });
  const moving = (async () => {
    try {
      await api
        .destinations({ id: "default" })
        .put({ downloadPath: target, moveFiles: true, name: "Moved" });
    } catch {
      /* SIGKILL closes the connection before the mutation can return. */
    }
  })();
  let receipt: { id: string; result: string } | null = null;
  try {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      receipt = database
        .query<{ id: string; result: string }, []>(
          "SELECT id, result FROM operation_receipts WHERE kind = 'move' AND status = 'pending'"
        )
        .get();
      if (receipt) {
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Observe the actual durable receipt before killing its writer.
      await Bun.sleep(1);
    }
    context.server.child.kill("SIGKILL");
    await context.server.child.exited;
    await moving;
    receipt = database
      .query<{ id: string; result: string }, []>(
        "SELECT id, result FROM operation_receipts WHERE kind = 'move'"
      )
      .get();
  } finally {
    database.close();
  }
  expect(receipt).not.toBeNull();
  const journal = JSON.parse(receipt?.result ?? "{}");
  const restarted = launchServer(context.config);
  try {
    const restored = treaty<Api>(await restarted.ready()).api;
    const host = expectSuccess(await restored.torrents({ id }).host.get());
    const activePath = journal.committed ? target : context.config.downloadPath;
    expect(host.savePath).toBe(activePath);
    expect(
      new Bun.CryptoHasher("sha256")
        .update(
          await Bun.file(join(activePath, context.seed.files[0]?.name ?? "Show - 01.mkv")).bytes()
        )
        .digest("hex")
    ).toBe(new Bun.CryptoHasher("sha256").update(context.bytes).digest("hex"));
    expect(await Bun.file(journal.staging).exists()).toBe(false);
    const state = expectSuccess(await restored.torrents({ id }).get());
    expect(state.storageIssue).toBeNull();
    // The normal mutation after recovery also completes through the same journal.
    expectSuccess(
      await restored
        .destinations({ id: "default" })
        .put({ downloadPath: target, moveFiles: true, name: "Moved" })
    );
    expect(expectSuccess(await restored.torrents({ id }).host.get()).savePath).toBe(target);
  } finally {
    await restarted.stop();
  }
}, 60_000);
