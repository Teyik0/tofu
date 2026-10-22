import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { application } from "../helpers/app";
import { sessionCookie, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";

test("an invitation grants device access and revocation invalidates its session", async () => {
  await using app = await application();
  const { client, url } = await app.start();
  const invitation = success(
    await client.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Phone",
      role: "playback",
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
  expect((await client.session.get()).status).toBe(401);
  const paired = await client.auth.pair.post(
    {
      kind: "browser",
      label: "Phone",
      nonce: crypto.randomUUID().replaceAll("-", ""),
      secret: invitation.secret,
    },
    { headers: { origin: url } }
  );
  const pairing = success(paired);
  if (!("device" in pairing)) {
    throw new Error("The invitation was not redeemed");
  }
  const { device } = pairing;
  const phone = treaty<Api>(url, {
    headers: { cookie: sessionCookie(paired.response), origin: url },
  }).api;
  expect(success(await phone.session.get()).caller).toMatchObject({
    kind: "device",
    role: "playback",
  });
  success(await phone.state.get());
  expect(success(await owner.access.devices.get())).toContainEqual(
    expect.objectContaining({ id: device.id })
  );
  success(await owner.access.devices({ id: device.id }).delete());
  expect((await phone.session.get()).status).toBe(401);
  expect((await phone.state.get()).status).toBe(401);
  expect(success(await owner.access.devices.get()).some((item) => item.id === device.id)).toBe(
    false
  );
});

test("public login pages render without exposing the library or protected endpoints", async () => {
  await using app = await application();
  const { client, url } = await app.start();
  success(
    await client.connections.put({
      enabled: true,
      proxyOrigin: "https://tofu.example.test",
      transport: "proxy",
    })
  );
  await Promise.all(
    [
      "/pair",
      "/signed-out",
      "/session-transfer",
      "/pair?_furin=data",
      "/signed-out?_furin=data",
      "/session-transfer?_furin=data",
    ].map(async (path) => {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(200);
      const document = await response.text();
      expect(document).toContain('"dashboard":null');
      expect(document).not.toContain('"torrents":');
      expect(document).not.toContain('"destinations":');
      expect(document).not.toContain(app.directory);
      if (!path.includes("?")) {
        expect(document).toContain('class="login-page"');
        expect(document).not.toContain('class="app-shell');
        const assets = [...document.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)]
          .map((match) => match[1])
          .filter(
            (asset): asset is string =>
              asset !== undefined && (asset.startsWith("/_client/") || asset.startsWith("/_bun/"))
          );
        expect(assets.length).toBeGreaterThan(0);
        const responses = await Promise.all(assets.map((asset) => fetch(`${url}${asset}`)));
        await Promise.all(
          responses.map(async (asset) => {
            expect(asset.status).toBe(200);
            await asset.arrayBuffer();
          })
        );
      }
    })
  );
  expect((await client.session.get()).status).toBe(401);
  expect((await client.state.get()).status).toBe(401);
  expect((await client.access.devices.get()).status).toBe(401);
  const privatePage = await fetch(`${url}/`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  expect(privatePage.status).toBe(302);
  expect(privatePage.headers.get("location")).toBe("/signed-out");
}, 30_000);

test("a persistent HTTPS browser session survives a new client and a server restart", async () => {
  await using app = await application();
  const { client, stop, url } = await app.start();
  const origin = "https://tofu.example.test";
  const forwarded = { origin, "x-forwarded-host": "tofu.example.test" };
  const invitation = success(
    await client.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Safari on iPhone",
      role: "playback",
    })
  );
  success(await client.connections.put({ enabled: true, proxyOrigin: origin, transport: "proxy" }));
  const paired = await client.auth.pair.post(
    {
      kind: "browser",
      label: "Safari on iPhone",
      nonce: crypto.randomUUID().replaceAll("-", ""),
      secret: invitation.secret,
    },
    { headers: forwarded }
  );
  const pairing = success(paired);
  if (!("device" in pairing)) {
    throw new Error("The invitation was not redeemed");
  }
  const header = paired.response.headers.get("set-cookie");
  expect(header).toStartWith("__Host-tofu-");
  expect(header).toContain("Max-Age=31536000");
  expect(header).toContain("Path=/");
  expect(header).toContain("HttpOnly");
  expect(header).toContain("Secure");
  expect(header).toContain("SameSite=Strict");
  expect(header).not.toContain("Domain=");
  const cookie = sessionCookie(paired.response);
  const reopened = treaty<Api>(url, { headers: { ...forwarded, cookie } }).api;
  expect(success(await reopened.session.get()).caller.id).toBe(pairing.device.id);

  await stop();
  const restarted = await app.start();
  const phone = treaty<Api>(restarted.url, { headers: { ...forwarded, cookie } }).api;
  expect(success(await phone.session.get()).caller.id).toBe(pairing.device.id);
  success(await phone.state.get());
  success(await phone.auth.logout.post());
  expect((await phone.session.get()).status).toBe(401);
}, 20_000);

test("remote grants restrict management, file deletion and access outside storage roots", async () => {
  await using source = await peer();
  await using app = await application();
  const { client, url } = await app.start();
  success(await client.torrents.post({ paused: false, source: source.magnet }));
  await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  const invitation = success(
    await client.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Phone",
      role: "playback",
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
      kind: "browser",
      label: "Phone",
      nonce: crypto.randomUUID().replaceAll("-", ""),
      secret: invitation.secret,
    },
    { headers: { origin: url } }
  );
  const pairing = success(paired);
  if (!("device" in pairing)) {
    throw new Error("The invitation was not redeemed");
  }
  const { device } = pairing;
  const phone = treaty<Api>(url, {
    headers: { cookie: sessionCookie(paired.response), origin: url },
  }).api;
  const library = success(await phone.state.get());
  expect(library.torrents).toHaveLength(1);
  expect(JSON.stringify(library)).not.toContain(app.directory);
  expect((await phone.torrents({ id: source.id }).files({ index: "0" }).content.get()).status).toBe(
    200
  );
  expect((await phone.torrents({ id: source.id }).pause.post({})).status).toBe(403);
  expect((await phone.torrents({ id: source.id }).host.get()).status).toBe(403);
  expect((await phone.access.devices.get()).status).toBe(403);

  success(await owner.access.devices({ id: device.id }).patch({ role: "management" }));
  success(await phone.torrents({ id: source.id }).pause.post({}));
  expect((await phone.torrents({ id: source.id }).delete({ deleteFiles: true })).status).toBe(403);
  expect((await phone.settings.patch({ downloadLimit: 1 })).status).toBe(403);
  expect(
    (await phone.torrents({ id: source.id }).files({ index: "999" }).content.get()).status
  ).toBe(404);

  success(await owner.access.devices({ id: device.id }).patch({ role: "administration" }));
  expect(
    (
      await phone.destinations.post({
        downloadPath: join(app.directory, "outside"),
        name: "Outside",
      })
    ).status
  ).toBe(403);
  const roots = success(await phone["storage-roots"].get());
  const [root] = roots;
  if (!root) {
    throw new Error("The server did not expose its storage root");
  }
  expect(root.path).toBeNull();
  expect(
    (
      await phone.destinations["within-root"].post({
        folder: "../escape",
        name: "Escape",
        rootId: root.id,
      })
    ).status
  ).toBe(400);
  expect(success(await owner.state.get()).torrents).toHaveLength(1);
  expect(new Uint8Array(await Bun.file(join(app.downloadPath, source.filename)).bytes())).toEqual(
    new Uint8Array(source.bytes)
  );
});
