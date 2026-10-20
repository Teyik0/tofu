import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { expectSuccess } from "../helpers/problem";
import { redemptionNonce, remoteServerFixture, sessionCookie } from "../helpers/remote";

const mib = 1024 * 1024;

test("paired devices see only what their grants allow across pages, data, live state and media", async () => {
  await using fixture = await remoteServerFixture(24 * mib);
  const { url } = fixture;
  const owner = treaty<Api>(url).api;

  // The owner downloads a real torrent from a real peer before opening the server to others.
  const added = expectSuccess(
    await owner.torrents.file.post({
      file: new File([new Uint8Array(fixture.seed.torrentFile)], "show.torrent"),
      paused: "false",
    })
  );
  expectSuccess(
    await owner.torrents({ id: added.id }).peers.post({
      peer: `127.0.0.1:${fixture.seeder.torrentPort}`,
    })
  );
  await fixture.complete(added.id);
  // A second torrent without any peer keeps its range reads waiting for pieces.
  const otherSource = `${fixture.directory}/seed/Other - 02.mkv`;
  await Bun.write(otherSource, crypto.getRandomValues(new Uint8Array(mib)));
  const other = await new Promise<{ torrentFile: Uint8Array }>((resolve) =>
    fixture.seeder.seed(otherSource, { announce: [] }, resolve)
  );
  const missing = expectSuccess(
    await owner.torrents.file.post({
      file: new File([new Uint8Array(other.torrentFile)], "other.torrent"),
      paused: "false",
    })
  );
  const playbackInvitation = expectSuccess(
    await owner.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Living room iPad",
      role: "playback",
    })
  );
  const adminInvitation = expectSuccess(
    await owner.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Laptop",
      role: "administration",
    })
  );
  const enabled = await owner.connections.put({
    enabled: true,
    proxyOrigin: "https://tofu.example.test",
    transport: "proxy",
  });
  expect(enabled.status).toBe(200);
  // The owner's loopback browser stays signed in as an administrator device.
  expect(sessionCookie(enabled.response)).toStartWith("tofu-");

  // Anonymous requests now reach only the public documents.
  expect((await owner.state.get()).status).toBe(401);
  const document = await fetch(`${url}/`, { headers: { accept: "text/html" }, redirect: "manual" });
  expect(document.status).toBe(302);
  expect(document.headers.get("location")).toBe("/signed-out");
  const descriptor = expectSuccess(await treaty<Api>(url)[".well-known"].tofu.get());
  expect(Object.keys(descriptor).sort()).toEqual([
    "appVersion",
    "name",
    "onboarding",
    "product",
    "protocol",
    "serverId",
  ]);
  const pairPage = await fetch(`${url}/pair`);
  expect(pairPage.status).toBe(200);
  expect(pairPage.headers.get("content-security-policy")).toContain("script-src 'sha256-");
  expect(pairPage.headers.get("referrer-policy")).toBe("no-referrer");

  // A browser previews, then redeems its invitation once.
  const anonymous = treaty<Api>(url, { headers: { origin: url } }).api;
  const nonce = redemptionNonce();
  const preview = expectSuccess(
    await anonymous.auth.pair.post({
      kind: "browser",
      label: "preview",
      nonce,
      preview: true,
      secret: playbackInvitation.secret,
    })
  );
  expect(preview).toMatchObject({ canDeleteFiles: false, role: "playback" });
  const paired = await anonymous.auth.pair.post({
    kind: "browser",
    label: "Living room iPad",
    nonce,
    secret: playbackInvitation.secret,
  });
  expect(paired.status).toBe(200);
  const firstCookie = sessionCookie(paired.response);

  // A lost response is recovered for the same device with the same nonce, never another device.
  const retried = await anonymous.auth.pair.post({
    kind: "browser",
    label: "Living room iPad",
    nonce,
    secret: playbackInvitation.secret,
  });
  expect(retried.status).toBe(200);
  expect(retried.data && "device" in retried.data ? retried.data.device.id : null).toBe(
    paired.data && "device" in paired.data ? paired.data.device.id : "missing"
  );
  const cookie = sessionCookie(retried.response);
  expect(
    (await treaty<Api>(url, { headers: { cookie: firstCookie } }).api.session.get()).status
  ).toBe(401);
  const reused = await anonymous.auth.pair.post({
    kind: "browser",
    label: "Another tablet",
    nonce: redemptionNonce(),
    secret: playbackInvitation.secret,
  });
  expect(reused.status).toBe(410);

  const playback = treaty<Api>(url, { headers: { cookie, origin: url } }).api;
  const session = expectSuccess(await playback.session.get());
  expect(session.caller.role).toBe("playback");
  expect(session.capabilities).toEqual({
    administer: false,
    deleteFiles: false,
    hostNative: false,
    manage: false,
    owner: false,
  });
  const library = expectSuccess(await playback.state.get());
  expect(library.torrents.map((torrent) => torrent.id).sort()).toEqual(
    [added.id, missing.id].sort()
  );
  expect(JSON.stringify(library)).not.toContain(fixture.directory);
  expect(library).not.toHaveProperty("settings");
  const detail = expectSuccess(await playback.torrents({ id: added.id }).get());
  expect(JSON.stringify(detail)).not.toContain(fixture.directory);
  expect(detail).not.toHaveProperty("savePath");

  // Privileged and host-native endpoints refuse Playback with literal statuses.
  expect((await playback.host.get()).status).toBe(403);
  expect((await playback.settings.get()).status).toBe(403);
  expect((await playback.torrents({ id: added.id }).host.get()).status).toBe(403);
  expect((await playback.access.invitations.get()).status).toBe(403);
  expect((await playback.instance.get()).status).toBe(403);
  expect((await playback.desktop.servers.get()).status).toBe(403);
  expect((await playback.desktop.servers.post({ action: "discover" })).status).toBe(403);
  expect((await playback.connections.tailscale.https.post()).status).toBe(403);
  expect((await playback.automation.get()).status).toBe(403);
  expect((await playback.torrents({ id: added.id }).pause.post()).status).toBe(403);
  expect((await playback.torrents({ id: added.id }).delete({ deleteFiles: true })).status).toBe(
    403
  );

  // Rendered documents and navigation data never carry host paths or settings.
  for (const path of [
    "/",
    `/thread/default?torrent=${added.id}`,
    "/options",
    "/options/downloads",
    "/anilist",
    "/plugins",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Each iteration depends on the previous lifecycle or readiness result.
    const html = await (await fetch(`${url}${path}`, { headers: { cookie } })).text();
    expect(html).not.toContain(fixture.directory);
    expect(html).not.toContain("downloadPath");
    const data = await fetch(`${url}/_furin/data?path=${encodeURIComponent(path)}`, {
      headers: { cookie },
    });
    expect(await data.text()).not.toContain(fixture.directory);
  }

  // Media reads honor HEAD, ranges and 416 for the paired device.
  const [file] = detail.files;
  if (!file) {
    throw new Error("The torrent has no file");
  }
  const stream = playback.torrents({ id: added.id }).files({ index: "0" }).stream({
    name: file.name,
  });
  const head = await stream.head();
  expect(new Headers(head.headers).get("content-length")).toBe(String(24 * mib));
  // Eden decodes video types as text, so byte-exact reads use the raw response.
  const part = await fetch(
    `${url}/api/torrents/${added.id}/files/0/stream/${encodeURIComponent(file.name)}`,
    { headers: { cookie, range: "bytes=-1024" } }
  );
  expect(part.status).toBe(206);
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(fixture.bytes.subarray(24 * mib - 1024));
  const outside = await stream.get({ headers: { range: `bytes=${24 * mib}-` } });
  expect(outside.status).toBe(416);
  expect(new Headers(outside.headers).get("content-range")).toBe(`bytes */${24 * mib}`);

  // Revoking the device ends its open media read, a pending range wait and its live stream.
  const reading = await fetch(
    `${url}/api/torrents/${added.id}/files/0/stream/${encodeURIComponent(file.name)}`,
    { headers: { cookie } }
  );
  const reader = reading.body?.getReader();
  if (!reader) {
    throw new Error("The media response has no body");
  }
  let received = (await reader.read()).value?.length ?? 0;
  const waiting = fetch(
    `${url}/api/torrents/${missing.id}/files/0/stream/${encodeURIComponent("Other - 02.mkv")}`,
    { headers: { cookie, range: "bytes=0-1023" } }
  );
  const live = await fetch(`${url}/api/live`, { headers: { cookie } });
  const liveReader = live.body?.getReader();
  await liveReader?.read();
  const adminPaired = await anonymous.auth.pair.post({
    kind: "browser",
    label: "Laptop",
    nonce: redemptionNonce(),
    secret: adminInvitation.secret,
  });
  const admin = treaty<Api>(url, {
    headers: { cookie: sessionCookie(adminPaired.response), origin: url },
  }).api;
  expect((await admin.desktop.servers.get()).status).toBe(403);
  expect((await admin.desktop.servers.post({ action: "discover" })).status).toBe(403);
  expect((await admin.connections.tailscale.https.post()).status).toBe(403);
  const devices = expectSuccess(await admin.access.devices.get());
  const device = devices.find((item) => item.label === "Living room iPad");
  if (!device) {
    throw new Error("The paired device is missing");
  }
  const revokedAt = performance.now();
  expectSuccess(await admin.access.devices({ id: device.id }).delete());
  const media = (async () => {
    try {
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: count bytes until the server stops sending.
        const chunk = await reader.read();
        if (chunk.done) {
          return "ended";
        }
        received += chunk.value.length;
      }
    } catch {
      return "aborted";
    }
  })();
  const events = (async () => {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: read until the live stream closes.
      while (!(await liveReader?.read())?.done) {
        // Snapshots sent before revocation are discarded.
      }
      return "ended";
    } catch {
      return "aborted";
    }
  })();
  const pending = (async () => {
    try {
      const response = await waiting;
      await response.arrayBuffer();
      return response.status;
    } catch {
      return "aborted";
    }
  })();
  const outcomes = await Promise.all([media, events, pending]);
  expect(performance.now() - revokedAt).toBeLessThan(1000);
  // Bun reports the truncated body as ended or aborted; either way the file was not delivered.
  expect(["ended", "aborted"]).toContain(outcomes[0]);
  // Delivery stopped: bytes already sent stay delivered, the rest of the file never is.
  expect(received).toBeLessThan(24 * mib);
  expect(["ended", "aborted"]).toContain(outcomes[1]);
  expect(outcomes[2]).not.toBe(206);
  expect((await playback.state.get()).status).toBe(401);
}, 60_000);

test("short codes burn their invitation after five wrong attempts", async () => {
  await using fixture = await remoteServerFixture(1024);
  const owner = treaty<Api>(fixture.url).api;
  const invitation = expectSuccess(
    await owner.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Phone",
      role: "playback",
    })
  );
  expectSuccess(
    await owner.connections.put({
      enabled: true,
      proxyOrigin: "https://tofu.example.test",
      transport: "proxy",
    })
  );
  const anonymous = treaty<Api>(fixture.url, { headers: { origin: fixture.url } }).api;
  const code = invitation.code.replace("-", "");
  // Same selector, wrong secret: each attempt counts against this invitation.
  const wrong = `${code.slice(0, 3)}${code.at(3) === "0" ? "1" : "0"}${code.slice(4)}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: attempts are counted in order.
    const failed = await anonymous.auth.pair.post({
      code: wrong,
      kind: "browser",
      label: "Phone",
      nonce: redemptionNonce(),
    });
    expect(failed.status).toBe(401);
  }
  const burned = await anonymous.auth.pair.post({
    code: invitation.code.toLowerCase(),
    kind: "browser",
    label: "Phone",
    nonce: redemptionNonce(),
  });
  expect(burned.status).toBe(410);
}, 30_000);
