import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { defaultConnectionPolicy } from "../src/api/modules/torrents/connections";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import type { ConnectionDiagnostics } from "../src/types";
import { createTestApi } from "./helpers/application";
import { openTestDatabase } from "./helpers/database";
import { expectSuccess } from "./helpers/problem";
import { network, waitFor } from "./helpers/torrent";

test("pending handshake capacity includes connected peers that never finish their handshake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-pending-handshakes-"));
  type PeerSocket = Awaited<ReturnType<typeof Bun.connect>>;
  const sockets = new Set<PeerSocket>();
  const peers = Array.from({ length: 12 }, () =>
    Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data() {
          // Accept TCP and deliberately leave the BitTorrent handshake unfinished.
        },
        open(socket) {
          sockets.add(socket);
        },
      },
    })
  );
  const engine = await TorrentEngine.open({
    connectionPolicy: {
      ...defaultConnectionPolicy,
      attemptsPerSecond: 100,
      burst: 12,
      maxPending: 8,
    },
    dataDir: join(directory, "state"),
    downloadPath: join(directory, "downloads"),
    network,
  });
  const sync = await openTestDatabase(join(directory, "sync"));
  try {
    const api = await createTestApi(() => engine, sync.options);
    const client = treaty(api).api;
    const added = await client.torrents.post({
      paused: false,
      source: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
    });
    expect(added.status).toBe(200);
    const { id } = expectSuccess(added) as { id: string };
    const responses = await Promise.all(
      peers.map((peer) => client.torrents({ id }).peers.post({ peer: `127.0.0.1:${peer.port}` }))
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await waitFor(
      async () => sockets.size,
      (count) => count >= 8
    );
    await Bun.sleep(250);
    expect(sockets.size).toBe(8);
    const diagnostics = expectSuccess(
      await client.diagnostics.connections.get()
    ) as ConnectionDiagnostics;
    expect(diagnostics.pendingOutgoing).toBe(8);
    expect(diagnostics.connectedOutgoing).toBe(8);
    expect(diagnostics.outgoingHandshakes).toBe(0);
    expect(diagnostics.queuedOutgoing).toBe(4);
    expect(diagnostics.deferredByCapacity).toBeGreaterThan(0);
  } finally {
    await engine.close();
    await sync.close();
    for (const socket of sockets) {
      socket.terminate();
    }
    for (const peer of peers) {
      peer.stop(true);
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
