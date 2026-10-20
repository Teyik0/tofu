import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { editorFixture } from "../helpers/anilist/editor";
import { expectSuccess } from "../helpers/problem";
import { remoteServerFixture, sessionCookie } from "../helpers/remote";

const mib = 1024 * 1024;

test("an episode playable on a linked server is offered in this server's AniList and only updates this AniList", async () => {
  // A: this server, with its owner's AniList account ("Example", 12 episodes, 2 watched).
  const a = await editorFixture();
  // B: another server holding episode 3, downloaded from a real peer.
  await using b = await remoteServerFixture(24 * mib, "Example - 03.mkv");
  try {
    const bOwner = treaty<Api>(b.url).api;
    const added = expectSuccess(
      await bOwner.torrents.file.post({
        file: new File([new Uint8Array(b.seed.torrentFile)], "example.torrent"),
        paused: "false",
      })
    );
    expectSuccess(
      await bOwner.torrents({ id: added.id }).peers.post({
        peer: `127.0.0.1:${b.seeder.torrentPort}`,
      })
    );
    await b.complete(added.id);
    const invitation = expectSuccess(
      await bOwner.access.invitations.post({
        canDeleteFiles: false,
        expiresInMinutes: 10,
        label: "Linked server",
        role: "playback",
      })
    );
    const opened = await bOwner.connections.put({
      enabled: true,
      proxyOrigin: "https://tofu.example.test",
      transport: "proxy",
    });
    const bAdmin = treaty<Api>(b.url, {
      headers: { cookie: sessionCookie(opened.response), origin: b.url },
    }).api;

    // A redeems B's invitation as a linked server; B records a Playback device for it.
    const link = expectSuccess(
      await a.client["linked-libraries"].post({
        address: b.url,
        label: "Alice's Tofu",
        secret: invitation.secret,
      })
    );
    expect(link).toMatchObject({ name: expect.any(String), state: "active" });
    const linkedDevice = expectSuccess(await bAdmin.access.devices.get()).find(
      (device) => device.label === "Alice's Tofu"
    );
    expect(linkedDevice).toMatchObject({ canDeleteFiles: false, kind: "server", role: "playback" });

    // One batch per anime: episode 3 is on B by title, episode 4 is nowhere.
    const byTitle = expectSuccess(
      await a.client["linked-libraries"].availability.post({
        episodes: [3, 4],
        infoHashes: [],
        key: "10",
        mediaId: 10,
        season: null,
        titles: ["Example"],
      })
    );
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0]).toMatchObject({
      link: { id: link.id },
      sources: [
        {
          episode: 3,
          fileIndex: 0,
          match: "title",
          status: "playable",
          torrentId: added.id,
        },
      ],
      state: "available",
    });
    const byHash = expectSuccess(
      await a.client["linked-libraries"].availability.post({
        episodes: [3],
        infoHashes: [added.id],
        key: "10-hash",
        season: null,
        titles: ["Example"],
      })
    );
    expect(byHash[0]?.sources[0]?.match).toBe("infohash");
    const otherSeason = expectSuccess(
      await a.client["linked-libraries"].availability.post({
        episodes: [3],
        infoHashes: [added.id],
        key: "10-season-two",
        season: 2,
        titles: ["Example"],
      })
    );
    expect(otherSeason[0]?.sources).toEqual([]);

    // A's player streams the file directly from B through a file-scoped link.
    const play = expectSuccess(
      await a.client["linked-libraries"]({ id: link.id }).play.post({
        fileIndex: 0,
        torrentId: added.id,
      })
    );
    expect(new URL(play.url).origin).toBe(b.url);
    const preflight = await fetch(play.url, {
      headers: {
        "access-control-request-headers": "range",
        "access-control-request-method": "GET",
        origin: "http://127.0.0.1:9",
      },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toBe("range");
    const range = await fetch(play.url, {
      headers: { origin: "http://127.0.0.1:9", range: "bytes=0-1023" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("access-control-allow-origin")).toBe("*");
    expect(range.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(b.bytes.subarray(0, 1024));

    // Revoking this file grant interrupts its active response without revoking the server link.
    const streaming = await fetch(play.url);
    const reader = streaming.body?.getReader();
    if (!reader) {
      throw new Error("Missing playback stream");
    }
    let delivered = (await reader.read()).value?.length ?? 0;
    expectSuccess(
      await a.client["linked-libraries"]({ id: link.id })["revoke-playback"].post({
        playbackId: play.id,
      })
    );
    try {
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: Consume until the revoked HTTP body terminates.
        const next = await reader.read();
        if (next.done) {
          break;
        }
        delivered += next.value.length;
      }
    } catch {
      /* An aborted HTTP body is the expected result of revocation. */
    }
    expect(delivered).toBeLessThan(b.bytes.length);
    expect((await fetch(play.url, { headers: { range: "bytes=0-1" } })).status).toBe(404);

    expect(
      (
        await a.client.anilist
          .entries({ mediaId: "10" })
          .episodes({ episode: "3" })
          .put({ accountId: 999, completed: true })
      ).status
    ).toBe(409);
    expect(a.remote.progressSaves).toEqual([]);
    // Finishing the episode updates A's AniList with A's token; B never sees an AniList call.
    expectSuccess(
      await a.client.anilist
        .entries({ mediaId: "10" })
        .episodes({ episode: "3" })
        .put({
          accountId: expectSuccess(await a.client.anilist.get()).accountId ?? undefined,
          completed: true,
        })
    );
    expect(a.remote.progressSaves).toEqual([{ progress: 3, token: "Bearer token" }]);
    const bAniList = expectSuccess(await bAdmin.anilist.get());
    expect(bAniList.authenticated).toBe(false);
    expect(bAniList.entries).toEqual([]);

    // B revokes the link: A reports it, and the issued link stops working at once.
    expectSuccess(await bAdmin.access.devices({ id: linkedDevice?.id ?? "" }).delete());
    expect((await fetch(play.url, { headers: { range: "bytes=0-1" } })).status).toBe(404);
    const revoked = expectSuccess(
      await a.client["linked-libraries"].availability.post({
        episodes: [3, 4, 5],
        infoHashes: [],
        key: "10-after",
        season: null,
        titles: ["Example"],
      })
    );
    expect(revoked[0]).toMatchObject({ sources: [], state: "revoked" });
    await b.server.stop();
    const logs = await b.server.output;
    expect(logs).not.toContain(new URL(play.url).pathname.split("/")[3] ?? "missing-token");
    expect(logs).not.toContain(invitation.secret);
  } finally {
    await a.close();
  }
}, 60_000);
