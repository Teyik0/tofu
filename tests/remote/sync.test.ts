import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { createSyncClient, furinSync } from "@teyik0/furin/sync/client";
import type { Api } from "../../src/api";
import { application } from "../helpers/app";
import { sessionCookie, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";

const NativeWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

test.each(["browser", "desktop"] as const)(
  "%s live queries follow transfers, changed grants and revocation",
  async (kind) => {
    await using source = await peer();
    await using app = await application({ entry: "tests/helpers/migrated-server.ts" });
    const { client, url } = await app.start();
    const invitation = success(
      await client.access.invitations.post({
        canDeleteFiles: false,
        expiresInMinutes: 10,
        label: "Live query reader",
        role: "administration",
      })
    );
    const sharing = await client.connections.put({
      enabled: true,
      proxyOrigin: "https://tofu.example.test",
      transport: "proxy",
    });
    success(sharing);
    const owner = treaty<Api>(url, {
      headers: { cookie: sessionCookie(sharing.response), origin: url },
    }).api;
    const paired = await client.auth.pair.post(
      {
        kind,
        label: "Live query reader",
        nonce: crypto.randomUUID().replaceAll("-", ""),
        secret: invitation.secret,
      },
      kind === "browser" ? { headers: { origin: url } } : undefined
    );
    const pairing = success(paired);
    if (!("device" in pairing)) {
      throw new Error("The invitation was not redeemed");
    }
    let cookie: string;
    if ("token" in pairing && pairing.token) {
      const native = treaty<Api>(url, {
        headers: { authorization: `Bearer ${pairing.token}` },
      }).api;
      const session = success(await native.auth["window-sessions"].post());
      cookie = `${session.cookie}=${session.value}`;
    } else {
      cookie = sessionCookie(paired.response);
    }
    const headers = { cookie, origin: url };
    const phone = treaty<Api>(url, { headers }).use(furinSync).api;
    const live = createSyncClient({
      createWebSocket: (address, socketHeaders) =>
        new NativeWebSocket(address, { headers: Object.fromEntries(socketHeaders) }),
      headers,
      url,
    });
    using cleanup = new DisposableStack();
    cleanup.defer(live.close);
    let state: Awaited<ReturnType<typeof phone.state.get>>["data"] | undefined;
    cleanup.defer(
      live.subscribe(phone.state.get.live({ query: { detail: "false" } }), ({ data }) => {
        state = data;
      })
    );
    await waitFor(
      () => state,
      (value) => value?.host !== null && value?.viewer?.capabilities.manage === true
    );
    success(await owner.torrents.post({ paused: false, source: source.magnet }));
    await waitFor(
      () => state,
      (value) =>
        value?.torrents.some((torrent) => torrent.id === source.id && torrent.progress === 1) ===
        true
    );
    success(await owner.access.devices({ id: pairing.device.id }).patch({ role: "playback" }));
    await waitFor(
      () => state,
      (value) => value?.host === null && value.viewer?.capabilities.manage === false
    );
    expect(live.getConnectionState().status).toBe("connected");
    success(await owner.access.devices({ id: pairing.device.id }).delete());
    await waitFor(
      () => live.getConnectionState(),
      (value) => value.status === "unauthorized"
    );
    expect(state).toBeUndefined();
    expect((await phone.state.get()).status).toBe(401);
  }
);
