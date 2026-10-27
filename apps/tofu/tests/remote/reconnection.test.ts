import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api/index";
import { application } from "../helpers/app";
import { sessionCookie, success } from "../helpers/assert";

const verificationCode = /^[A-F0-9]{4}-[A-F0-9]{4}$/;
const browserSecret = "a".repeat(43);
const otherSecret = "b".repeat(43);

test("a scanned QR needs matching approval and creates an independently revocable browser", async () => {
  await using app = await application();
  const { client, url } = await app.start();
  const invitation = success(
    await client.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Safari",
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
      label: "Safari",
      nonce: crypto.randomUUID().replaceAll("-", ""),
      secret: invitation.secret,
    },
    { headers: { origin: url } }
  );
  success(paired);
  const safari = treaty<Api>(url, {
    headers: { cookie: sessionCookie(paired.response), origin: url },
  }).api;
  const before = success(await safari.session.get());
  if (before.caller.kind !== "device") {
    throw new Error("Expected a paired browser");
  }
  const devices = owner.access.devices({ id: before.caller.id });
  expect(
    (await safari.access.devices({ id: before.caller.id }).reconnections.post({ origin: url }))
      .status
  ).toBe(403);
  expect((await devices.reconnections.post({ origin: "https://attacker.example" })).status).toBe(
    400
  );
  const request = success(await devices.reconnections.post({ origin: url }));
  const transfer = success(await owner.auth["session-transfers"].post());
  const otherSession = await client.auth["session-transfers"].redeem.post(
    { secret: transfer.secret },
    { headers: { origin: url } }
  );
  success(otherSession);
  const otherAdministrator = treaty<Api>(url, {
    headers: { cookie: sessionCookie(otherSession.response), origin: url },
  }).api;
  expect(
    (
      await otherAdministrator.access
        .devices({ id: before.caller.id })
        .reconnections({ requestId: request.id })
        .get()
    ).status
  ).toBe(403);
  expect(
    (
      await otherAdministrator.access
        .devices({ id: before.caller.id })
        .reconnections({ requestId: request.id })
        .post({ approve: true, code: "" })
    ).status
  ).toBe(403);

  expect(
    (await devices.reconnections({ requestId: request.id }).post({ approve: true, code: "" }))
      .status
  ).toBe(409);
  const target = treaty<Api>(url, { headers: { origin: url } }).api;
  const claim = success(
    await target.auth.reconnections.claim.post({
      browserSecret,
      label: "Scanner browser",
      secret: request.secret,
    })
  );
  expect(claim.code).toMatch(verificationCode);
  expect((await target.session.get()).status).toBe(401);
  expect(
    success(await target.auth.reconnections.complete.post({ browserSecret, id: request.id }))
  ).toEqual({ pending: true });
  expect(
    (
      await target.auth.reconnections.claim.post({
        browserSecret: otherSecret,
        label: "Another phone",
        secret: request.secret,
      })
    ).status
  ).toBe(409);
  expect(
    (await target.auth.reconnections.complete.post({ browserSecret: otherSecret, id: request.id }))
      .status
  ).toBe(403);
  expect(
    (
      await client.auth.reconnections.claim.post(
        { browserSecret, label: "Wrong origin", secret: request.secret },
        {
          headers: { origin: "https://tofu.example.test", "x-forwarded-host": "tofu.example.test" },
        }
      )
    ).status
  ).toBe(403);
  const status = success(await devices.reconnections({ requestId: request.id }).get());
  expect(status.code).toBe(claim.code);
  expect(status.label).toBe("Scanner browser");
  expect(
    (await devices.reconnections({ requestId: request.id }).post({ approve: true, code: "WRONG" }))
      .status
  ).toBe(409);
  success(
    await devices
      .reconnections({ requestId: request.id })
      .post({ approve: true, code: String(claim.code) })
  );
  const results = await Promise.all([
    target.auth.reconnections.complete.post({ browserSecret, id: request.id }),
    target.auth.reconnections.complete.post({ browserSecret, id: request.id }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 410]);
  const connected = results.find((result) => result.status === 200);
  if (!connected) {
    throw new Error("No browser connection established");
  }
  const scanner = treaty<Api>(url, {
    headers: { cookie: sessionCookie(connected.response), origin: url },
  }).api;
  const after = success(await scanner.session.get());
  expect(after.caller).toMatchObject({
    canDeleteFiles: before.caller.canDeleteFiles,
    profileId: before.caller.profileId,
    role: before.caller.role,
  });
  expect(after.caller.id).not.toBe(before.caller.id);
  expect(success(await devices.reconnections({ requestId: request.id }).get()).completed).toBe(
    true
  );
  success(await scanner.state.get());
  success(await scanner.auth.logout.post());
  expect((await scanner.session.get()).status).toBe(401);
  success(await safari.session.get());

  const rejected = success(await devices.reconnections.post({ origin: url }));
  success(
    await devices.reconnections({ requestId: rejected.id }).post({ approve: false, code: "" })
  );
  expect(
    (
      await target.auth.reconnections.claim.post({
        browserSecret,
        label: "Denied",
        secret: rejected.secret,
      })
    ).status
  ).toBe(410);
  const replaced = success(await devices.reconnections.post({ origin: url }));
  const changed = success(await devices.reconnections.post({ origin: url }));
  expect(
    (
      await target.auth.reconnections.claim.post({
        browserSecret,
        label: "Old QR",
        secret: replaced.secret,
      })
    ).status
  ).toBe(410);
  const pending = success(
    await target.auth.reconnections.claim.post({
      browserSecret,
      label: "Changed",
      secret: changed.secret,
    })
  );
  success(
    await devices
      .reconnections({ requestId: changed.id })
      .post({ approve: true, code: String(pending.code) })
  );
  success(await devices.patch({ role: "management" }));
  expect(
    (await target.auth.reconnections.complete.post({ browserSecret, id: changed.id })).status
  ).toBe(410);
  const revoked = success(await devices.reconnections.post({ origin: url }));
  success(await devices.delete());
  expect(
    (
      await target.auth.reconnections.claim.post({
        browserSecret,
        label: "Revoked",
        secret: revoked.secret,
      })
    ).status
  ).toBe(410);
}, 30_000);

test("browser reconnection approval expires after one minute", async () => {
  await using app = await application();
  const { client, url } = await app.start();
  const invitation = success(
    await client.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "Safari",
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
  const pair = success(
    await client.auth.pair.post(
      {
        kind: "browser",
        label: "Safari",
        nonce: crypto.randomUUID().replaceAll("-", ""),
        secret: invitation.secret,
      },
      { headers: { origin: url } }
    )
  );
  if (!("device" in pair)) {
    throw new Error("No paired device");
  }
  const device = owner.access.devices({ id: pair.device.id });
  const request = success(await device.reconnections.post({ origin: url }));
  const target = treaty<Api>(url, { headers: { origin: url } }).api;
  const claim = success(
    await target.auth.reconnections.claim.post({
      browserSecret,
      label: "Scanner",
      secret: request.secret,
    })
  );
  success(
    await device
      .reconnections({ requestId: request.id })
      .post({ approve: true, code: String(claim.code) })
  );
  await Bun.sleep(Math.max(0, request.expiresAt - Date.now() + 20));
  expect(
    (await target.auth.reconnections.complete.post({ browserSecret, id: request.id })).status
  ).toBe(410);
  expect((await target.session.get()).status).toBe(401);
}, 75_000);
