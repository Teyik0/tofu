import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { expectSuccess } from "../helpers/problem";
import { redemptionNonce, remoteServerFixture, sessionCookie } from "../helpers/remote";
import { launchServer } from "../helpers/server-process";

test("stable device receipts survive grants and restart, storage is bounded, and progress accepts deliberate rewind", async () => {
  await using context = await remoteServerFixture(32_768);
  const initial = treaty<Api>(context.url).api;
  const foreign = join(context.config.downloadPath, context.seed.files[0]?.name ?? "Show - 01.mkv");
  await Bun.write(foreign, "This file belongs to someone else");
  const collision = await initial.torrents.file.post({
    destinationId: "default",
    file: new File([new Uint8Array(context.seed.torrentFile)], "source.torrent"),
    paused: "true",
  });
  expect(collision.status).toBe(409);
  expect(await Bun.file(foreign).text()).toBe("This file belongs to someone else");
  await rm(foreign);
  const invitation = expectSuccess(
    await initial.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Manager",
      role: "management",
    })
  );
  const sharing = await initial.connections.put({
    enabled: true,
    proxyOrigin: "https://fixture.invalid",
    transport: "proxy",
  });
  expectSuccess(sharing);
  const ownerCookie = sessionCookie(sharing.response);
  let owner = treaty<Api>(context.url, {
    headers: { cookie: ownerCookie, origin: context.url },
  }).api;
  const paired = await initial.auth.pair.post(
    { kind: "browser", label: "Player", nonce: redemptionNonce(), secret: invitation.secret },
    { headers: { origin: context.url } }
  );
  const pairing = expectSuccess(paired);
  if (!("device" in pairing)) {
    throw new Error("Expected a redeemed invitation");
  }
  const { device } = pairing;
  const cookie = sessionCookie(paired.response);
  let client = treaty<Api>(context.url, { headers: { cookie, origin: context.url } }).api;
  const body = {
    destinationId: "default",
    file: new File([new Uint8Array(context.seed.torrentFile)], "source.torrent"),
    paused: "true" as const,
  };
  const idempotency = { headers: { "idempotency-key": "recovery-add" } };
  const added = expectSuccess(await client.torrents.file.post(body, idempotency));
  expect((await client.torrents.file.post({ ...body, paused: "false" }, idempotency)).status).toBe(
    409
  );
  expectSuccess(await owner.access.devices({ id: device.id }).patch({ role: "playback" }));
  expect((await client.torrents.file.post(body, idempotency)).status).toBe(403);
  expectSuccess(await owner.access.devices({ id: device.id }).patch({ role: "management" }));
  expect(expectSuccess(await client.torrents.file.post(body, idempotency)).id).toBe(added.id);
  expect(expectSuccess(await client.state.get()).torrents).toHaveLength(1);
  const key = `${added.id}:0:32768`;
  expectSuccess(
    await client.playback
      .positions({ mediaKey: key })
      .put({ duration: 100, position: 90, sequence: 2, sessionId: "player-a" })
  );
  expectSuccess(
    await client.playback
      .positions({ mediaKey: key })
      .put({ duration: 100, position: 50, sequence: 1, sessionId: "player-b" })
  );
  expect(
    expectSuccess(
      await client.playback
        .positions({ mediaKey: key })
        .put({ duration: 100, position: 10, sequence: 1, sessionId: "player-a" })
    ).accepted
  ).toBe(false);
  expectSuccess(
    await client.playback
      .positions({ mediaKey: key })
      .put({ duration: 100, position: 12, sequence: 3, sessionId: "player-a" })
  );
  expect(expectSuccess(await client.playback.positions({ mediaKey: key }).get()).position).toBe(12);
  expect(
    expectSuccess(await owner.playback.positions({ mediaKey: key }).get()).position
  ).toBeNull();
  context.server.child.kill("SIGKILL");
  await context.server.child.exited;
  const restarted = launchServer(context.config);
  try {
    const origin = await restarted.ready();
    client = treaty<Api>(origin, { headers: { cookie, origin } }).api;
    owner = treaty<Api>(origin, { headers: { cookie: ownerCookie, origin } }).api;
    expect(expectSuccess(await client.torrents.file.post(body, idempotency)).id).toBe(added.id);
    expectSuccess(await owner.access.devices({ id: device.id }).patch({ role: "administration" }));
    expect(
      (
        await client.destinations.post({
          downloadPath: join(context.directory, "escape"),
          name: "Escape",
        })
      ).status
    ).toBe(403);
    const roots = expectSuccess(await client["storage-roots"].get());
    expect(roots[0]?.path).toBeNull();
    const [root] = roots;
    if (!root) {
      throw new Error("Missing storage root");
    }
    expect(
      (
        await client.destinations["within-root"].post({
          folder: "../escape",
          name: "Escape",
          rootId: root.id,
        })
      ).status
    ).toBe(400);
    const bounded = expectSuccess(
      await client.destinations["within-root"].post({
        folder: "Anime",
        name: "Anime",
        rootId: root.id,
      })
    );
    expect(bounded.id).toBeTruthy();
    const removal = { headers: { "idempotency-key": "recovery-remove" } };
    expectSuccess(await client.torrents({ id: added.id }).delete({ deleteFiles: false }, removal));
    expectSuccess(await client.torrents({ id: added.id }).delete({ deleteFiles: false }, removal));
    expect(
      (await client.torrents({ id: added.id }).delete({ deleteFiles: true }, removal)).status
    ).toBe(403);
    expect(expectSuccess(await client.state.get()).torrents).toHaveLength(0);
  } finally {
    await restarted.stop();
  }
}, 60_000);

test("offline clone recovery rotates identity and removes inherited accounts and remote grants", async () => {
  await using context = await remoteServerFixture(1024);
  const owner = treaty<Api>(context.url).api;
  const previous = expectSuccess(await owner.session.get()).server.id;
  expectSuccess(
    await owner.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Old",
      role: "playback",
    })
  );
  await context.server.stop();
  const cli = Bun.spawn(
    [process.execPath, "scripts/tofu-admin.ts", "clone-identity", "--confirm-clone"],
    {
      env: {
        ...process.env,
        TOFU_DATA_DIR: context.config.dataDir,
        TOFU_DOWNLOAD_DIR: context.config.downloadPath,
        TOFU_MODE: "server",
        TOFU_PROFILE: "dev",
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [code, output, errors] = await Promise.all([
    cli.exited,
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
  ]);
  expect(code, errors).toBe(0);
  expect(JSON.parse(output).serverId).not.toBe(previous);
  const restarted = launchServer(context.config);
  try {
    const next = treaty<Api>(await restarted.ready()).api;
    expect(expectSuccess(await next.session.get()).server.id).not.toBe(previous);
    expect(expectSuccess(await next.session.get()).remoteAccess.enabled).toBe(false);
    expect(expectSuccess(await next.access.invitations.get())).toEqual([]);
    expect(expectSuccess(await next.access.devices.get())).toEqual([]);
    expect(expectSuccess(await next.anilist.get()).authenticated).toBe(false);
  } finally {
    await restarted.stop();
  }
}, 30_000);

test("offline revoke-all ends every remote device and pending invitation", async () => {
  await using context = await remoteServerFixture(1024);
  const owner = treaty<Api>(context.url).api;
  const used = expectSuccess(
    await owner.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Phone",
      role: "playback",
    })
  );
  expectSuccess(
    await owner.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Pending",
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
  const paired = await treaty<Api>(context.url, {
    headers: { origin: context.url },
  }).api.auth.pair.post({
    kind: "browser",
    label: "Phone",
    nonce: redemptionNonce(),
    secret: used.secret,
  });
  const phone = treaty<Api>(context.url, {
    headers: { cookie: sessionCookie(paired.response), origin: context.url },
  }).api;
  expectSuccess(await phone.session.get());
  await context.server.stop();
  const admin = async (...args: string[]) => {
    const cli = Bun.spawn([process.execPath, "scripts/tofu-admin.ts", ...args], {
      env: {
        ...process.env,
        TOFU_DATA_DIR: context.config.dataDir,
        TOFU_DOWNLOAD_DIR: context.config.downloadPath,
        TOFU_MODE: "server",
        TOFU_PROFILE: "dev",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [code, output, errors] = await Promise.all([
      cli.exited,
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
    ]);
    expect(code, errors).toBe(0);
    return JSON.parse(output) as unknown;
  };
  // The phone and the owner's adopted browser are both remote devices.
  expect(await admin("revoke-all")).toEqual({ revoked: 2 });
  expect(await admin("devices")).toEqual([]);
  const restarted = launchServer(context.config);
  try {
    const origin = await restarted.ready();
    const again = treaty<Api>(origin, {
      headers: { cookie: sessionCookie(paired.response), origin },
    }).api;
    expect((await again.session.get()).status).toBe(401);
  } finally {
    await restarted.stop();
  }
}, 30_000);

test("AniList native callbacks remain bound to the device that started authorization", async () => {
  await using context = await remoteServerFixture(1024);
  const initial = treaty<Api>(context.url).api;
  expectSuccess(
    await initial.anilist.put({
      clientId: "1234",
      clientSecret: "",
      redirectUri: "tofu://oauth/anilist",
      userName: "",
    })
  );
  const invitations = await Promise.all(
    ["First", "Second"].map((label) =>
      initial.access.invitations.post({
        canDeleteFiles: false,
        expiresInMinutes: 10,
        label,
        role: "administration",
      })
    )
  );
  expectSuccess(
    await initial.connections.put({
      enabled: true,
      proxyOrigin: "https://fixture.invalid",
      transport: "proxy",
    })
  );
  const devices = await Promise.all(
    invitations.map(async (invitation) => {
      const created = expectSuccess(invitation);
      const result = expectSuccess(
        await initial.auth.pair.post({
          kind: "desktop",
          label: created.invitation.label,
          nonce: redemptionNonce(),
          secret: created.secret,
        })
      );
      if (!("token" in result)) {
        throw new Error("Missing native credential");
      }
      return {
        client: treaty<Api>(context.url, { headers: { authorization: `Bearer ${result.token}` } })
          .api,
      };
    })
  );
  const [first, second] = devices;
  if (!(first && second)) {
    throw new Error("Two native devices are required");
  }
  const windowSession = expectSuccess(await first.client.auth["window-sessions"].post());
  const windowClient = treaty<Api>(context.url, {
    headers: { cookie: `${windowSession.cookie}=${windowSession.value}`, origin: context.url },
  }).api;
  const started = expectSuccess(await windowClient.anilist.connect.post());
  const state = new URL(started.url).searchParams.get("state");
  const callback = `tofu://oauth/anilist#${new URLSearchParams({ access_token: "must-not-be-sent", state: state ?? "" })}`;
  expect(
    (await second.client.anilist.oauth["remote-callback"].post({ url: callback })).status
  ).toBe(400);
  expect(
    (
      await first.client.anilist.oauth["remote-callback"].post({
        url: "tofu://oauth/anilist#state=wrong&access_token=must-not-be-sent",
      })
    ).status
  ).toBe(400);
  expect(expectSuccess(await windowClient.anilist.get()).authenticated).toBe(false);
  const live = await fetch(`${context.url}/api/live`, {
    headers: { cookie: `${windowSession.cookie}=${windowSession.value}` },
  });
  const reader = live.body?.getReader();
  if (!reader) {
    throw new Error("Missing window event stream");
  }
  await reader.read();
  const ended = (async () => {
    try {
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: Wait for the actual window stream to end after sign-out.
        if ((await reader.read()).done) {
          return true;
        }
      }
    } catch {
      return true;
    }
  })();
  expectSuccess(await windowClient.auth.logout.post());
  expect(await Promise.race([ended, Bun.sleep(1500)])).toBe(true);
  expect((await windowClient.session.get()).status).toBe(401);
  expect(expectSuccess(await first.client.session.get()).caller.kind).toBe("device");
}, 30_000);
