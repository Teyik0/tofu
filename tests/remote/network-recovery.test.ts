import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { expectSuccess } from "../helpers/problem";
import { redemptionNonce, remoteServerFixture, sessionCookie } from "../helpers/remote";
import { launchServer } from "../helpers/server-process";

test("headless LAN TLS rebinds one listener, reverts an unconfirmed crash, and retains a confirmed change", async () => {
  await using context = await remoteServerFixture(1024);
  const owner = treaty<Api>(context.url).api;
  expectSuccess(await owner.connections.certificate.post());
  const ca = await Bun.file(join(context.config.dataDir, "tls/ca.pem")).text();
  const invitation = expectSuccess(
    await owner.access.invitations.post({
      canDeleteFiles: false,
      expiresInMinutes: 10,
      label: "TLS recovery",
      role: "administration",
    })
  );
  const opened = await owner.connections.put({
    enabled: true,
    proxyOrigin: "https://fixture.invalid",
    transport: "proxy",
  });
  expectSuccess(opened);
  const cookie = sessionCookie(opened.response);
  let admin = treaty<Api>(context.url, { headers: { cookie, origin: context.url } }).api;
  expect(
    expectSuccess(await admin.connections.put({ enabled: true, transport: "lan" })).restarting
  ).toBe(true);
  expect(await context.server.child.exited).toBe(75);
  const first = launchServer(context.config, undefined, ca);
  let secureCookie = "";
  try {
    const origin = await first.ready();
    expect(origin.startsWith("https:")).toBe(true);
    const secure = treaty<Api>(origin, {
      fetch: { cache: "no-store", tls: { ca } } as RequestInit,
      headers: { origin },
    }).api;
    const paired = await secure.auth.pair.post({
      kind: "browser",
      label: "TLS administrator",
      nonce: redemptionNonce(),
      secret: invitation.secret,
    });
    expectSuccess(paired);
    secureCookie = sessionCookie(paired.response);
    const client = treaty<Api>(origin, {
      fetch: { cache: "no-store", tls: { ca } } as RequestInit,
      headers: { cookie: secureCookie, origin },
    }).api;
    expect(expectSuccess(await client.connections.get()).listening.pendingConfirmation?.local).toBe(
      false
    );
    first.child.kill("SIGKILL");
    await first.child.exited;
  } finally {
    await first.stop();
  }
  const reverted = launchServer(context.config);
  try {
    const origin = await reverted.ready();
    expect(origin.startsWith("http:")).toBe(true);
    admin = treaty<Api>(origin, { headers: { cookie, origin } }).api;
    expect(expectSuccess(await admin.connections.get()).config.transport).toBe("proxy");
    expect(expectSuccess(await admin.connections.get()).listening.pendingConfirmation).toBeNull();
    expectSuccess(await admin.connections.put({ enabled: true, transport: "lan" }));
    expect(await reverted.child.exited).toBe(75);
  } finally {
    await reverted.stop();
  }
  const confirmed = launchServer(context.config, undefined, ca);
  try {
    const origin = await confirmed.ready();
    const client = treaty<Api>(origin, {
      fetch: { cache: "no-store", tls: { ca } } as RequestInit,
      headers: { cookie: secureCookie, origin },
    }).api;
    expectSuccess(await client.connections.confirm.post());
  } finally {
    await confirmed.stop();
  }
  const persistent = launchServer(context.config, undefined, ca);
  try {
    const origin = await persistent.ready();
    const client = treaty<Api>(origin, {
      fetch: { cache: "no-store", tls: { ca } } as RequestInit,
      headers: { cookie: secureCookie, origin },
    }).api;
    expect(expectSuccess(await client.connections.get()).config.transport).toBe("lan");
    expect(expectSuccess(await client.connections.get()).listening.pendingConfirmation).toBeNull();
  } finally {
    await persistent.stop();
  }
}, 60_000);
