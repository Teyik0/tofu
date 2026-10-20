import { expect, test } from "bun:test";
import { expectSuccess } from "./helpers/problem";
import { fixture, waitFor } from "./helpers/torrent";

test("a torrent rejects an incoming connection from its own peer id", async () => {
  const context = await fixture(64 * 1024, []);
  try {
    const added = await context.client.torrents.post({ paused: false, source: context.magnet });
    const { id } = expectSuccess(added) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.state.get({ query: { selected: id } })),
      (snapshot) => snapshot.detail?.status === "seeding"
    );
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: expectSuccess(await context.client.host.get()).session.port,
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
    const host = expectSuccess(await context.client.torrents({ id }).host.get());
    socket.end();
    expect(
      host.peerList.filter((peer) => peer.id.startsWith(`${context.engine.client.peerId}-`))
    ).toHaveLength(0);
  } finally {
    await context.close();
  }
});
