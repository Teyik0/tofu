import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api/index";
import { application } from "../helpers/app";
import { sessionCookie, success } from "../helpers/assert";

test("a browser transfers its existing device once, preserving grants and profile", async () => {
  await using app = await application();
  const { client, url, stop } = await app.start();
  expect((await client.auth["session-transfers"].post()).status).toBe(403);
  const invitation = success(
    await client.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Phone",
      role: "playback",
    })
  );
  const origin = "https://tofu.example.test";
  const forwarded = { origin, "x-forwarded-host": "tofu.example.test" };
  const sharing = await client.connections.put({
    enabled: true,
    proxyOrigin: origin,
    transport: "proxy",
  });
  success(sharing);
  expect((await client.auth["session-transfers"].post()).status).toBe(401);
  const paired = await client.auth.pair.post(
    {
      kind: "browser",
      label: "Phone",
      nonce: crypto.randomUUID().replaceAll("-", ""),
      secret: invitation.secret,
    },
    { headers: forwarded }
  );
  success(paired);
  const source = treaty<Api>(url, {
    headers: { ...forwarded, cookie: sessionCookie(paired.response) },
  }).api;
  const before = success(await source.session.get());
  if (before.caller.kind !== "device") {
    throw new Error("The paired browser must have a device");
  }
  const deviceId = before.caller.id;
  const transfer = success(await source.auth["session-transfers"].post());
  expect(transfer.expiresAt - Date.now()).toBeGreaterThan(50_000);
  expect(transfer.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
  expect(
    (
      await client.auth["session-transfers"].redeem.post(
        { secret: transfer.secret },
        { headers: { origin: url } }
      )
    ).status
  ).toBe(403);

  // A browser handoff remains usable when the server restarts within its short lifetime.
  await stop();
  const restarted = await app.start();
  const target = treaty<Api>(restarted.url, { headers: forwarded }).api;
  const responses = await Promise.all([
    target.auth["session-transfers"].redeem.post({ secret: transfer.secret }),
    target.auth["session-transfers"].redeem.post({ secret: transfer.secret }),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 410]);
  const redeemed = responses.find((response) => response.status === 200);
  if (!redeemed) {
    throw new Error("The transfer did not establish a session");
  }
  const header = redeemed.response.headers.get("set-cookie");
  expect(header).toStartWith("__Host-tofu-");
  expect(header).toContain("HttpOnly");
  expect(header).toContain("Secure");
  expect(header).toContain("SameSite=Strict");
  const safari = treaty<Api>(restarted.url, {
    headers: { ...forwarded, cookie: sessionCookie(redeemed.response) },
  }).api;
  expect(success(await safari.session.get()).caller).toEqual(before.caller);
  expect((await safari.access.devices.get()).status).toBe(403);
  success(await safari.state.get());

  const phone = treaty<Api>(restarted.url, {
    headers: { ...forwarded, cookie: sessionCookie(paired.response) },
  }).api;
  const previous = success(await phone.auth["session-transfers"].post());
  const pending = success(await phone.auth["session-transfers"].post());
  expect(
    (await target.auth["session-transfers"].redeem.post({ secret: previous.secret })).status
  ).toBe(410);
  const administrator = treaty<Api>(restarted.url, {
    headers: { cookie: sessionCookie(sharing.response), origin: restarted.url },
  }).api;
  success(await administrator.access.devices({ id: deviceId }).patch({ role: "management" }));
  expect(
    (await target.auth["session-transfers"].redeem.post({ secret: pending.secret })).status
  ).toBe(410);
  const revoked = success(await phone.auth["session-transfers"].post());
  success(await administrator.access.devices({ id: deviceId }).delete());
  expect(
    (await target.auth["session-transfers"].redeem.post({ secret: revoked.secret })).status
  ).toBe(410);
  expect((await safari.session.get()).status).toBe(401);
}, 30_000);

test("session transfer links expire after one minute", async () => {
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
  success(
    await client.connections.put({
      enabled: true,
      proxyOrigin: "https://tofu.example.test",
      transport: "proxy",
    })
  );
  const paired = await client.auth.pair.post(
    {
      kind: "browser",
      label: "Phone",
      nonce: crypto.randomUUID().replaceAll("-", ""),
      secret: invitation.secret,
    },
    { headers: { origin: url } }
  );
  success(paired);
  const phone = treaty<Api>(url, {
    headers: { cookie: sessionCookie(paired.response), origin: url },
  }).api;
  const transfer = success(await phone.auth["session-transfers"].post());
  await Bun.sleep(Math.max(0, transfer.expiresAt - Date.now() + 20));
  expect(
    (
      await client.auth["session-transfers"].redeem.post(
        { secret: transfer.secret },
        { headers: { origin: url } }
      )
    ).status
  ).toBe(410);
  success(await phone.session.get());
}, 75_000);
