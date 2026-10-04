import { expect, test } from "bun:test";
import { fixture, json, waitFor } from "./helpers";

test("a torrent rejects an incoming connection from its own peer id", async () => {
  const context = await fixture(64 * 1024, []);
  try {
    const added = await context.request(
      "/torrents",
      json({ paused: false, source: context.magnet })
    );
    const { id } = (await added.json()) as { id: string };
    await waitFor(
      async () => context.engine.snapshot(id),
      (snapshot) => snapshot.detail?.progress === 1
    );
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: context.engine.snapshot(id).session.port,
      socket: {
        data() {
          /* The server's handshake is not needed for this assertion. */
        },
        open(connection) {
          connection.write(
            Buffer.concat([
              Buffer.from([19]),
              Buffer.from("BitTorrent protocol"),
              Buffer.alloc(8),
              Buffer.from(id, "hex"),
              Buffer.from(context.engine.client.peerId, "hex"),
            ])
          );
        },
      },
    });
    await Bun.sleep(500);
    const state = context.engine.snapshot(id);
    socket.end();
    expect(
      state.detail?.peerList.filter((peer) =>
        peer.id.startsWith(`${context.engine.client.peerId}-`)
      )
    ).toHaveLength(0);
  } finally {
    await context.close();
  }
});
