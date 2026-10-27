import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api/index";
import { application } from "../helpers/app";
import { sessionCookie, success } from "../helpers/assert";

test("the network companion starts explicitly and rejected changes keep sharing off", async () => {
  await using app = await application({ entry: "tests/helpers/network-server.ts" });
  const { client, url } = await app.start();
  const state = success(await client.connections.get());
  expect(state.listening.port).toBe(Number(new URL(url).port));
  expect(state.config).not.toHaveProperty("port");
  expect(state.enabled).toBe(false);
  expect(
    (
      await client.connections.put({
        enabled: true,
        lanPort: state.listening.port,
        transport: "lan",
      })
    ).status
  ).toBe(400);
  expect((await client.connections.put({ enabled: true, transport: "lan" })).status).toBe(409);

  const responses = await Promise.all([
    client.connections.tailscale.embedded.get(),
    client.connections.tailscale.embedded.get(),
    client.connections.tailscale.https.post(),
  ]);
  for (const response of responses) {
    expect(success(response).state).toBe("stopped");
  }
  expect(success(await client.connections.get()).enabled).toBe(false);
  expect(success(await client.connections.tailscale.check.post()).state).toBe("not-installed");
});

test("local HTTPS forwarding is restored during initialization and released on shutdown", async () => {
  await using app = await application({ entry: "tests/helpers/network-server.ts" });
  const server = await app.start();
  const certificate = success(await server.client.connections.certificate.post());
  expect(certificate.fingerprint).toBeString();

  const reservation = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const lanPort = reservation.port;
  reservation.stop();
  const shared = await server.client.connections.put({
    enabled: true,
    lanPort,
    transport: "lan",
  });
  success(shared);
  const cookie = sessionCookie(shared.response);
  let owner = treaty<Api>(server.url, { headers: { cookie, origin: server.url } }).api;
  const before = success(await owner.connections.get());
  expect(before.exposures.lan.state).toBe("ready");
  const [origin] = before.addresses;
  if (!origin) {
    throw new Error("The native ingress did not publish an HTTPS address");
  }
  const address = new URL(origin);
  const transport: BunFetchRequestInit = {
    tls: {
      ca: await Bun.file(join(app.directory, "state/tls/ca.pem")).text(),
      serverName: address.hostname,
    },
  };
  const lan = treaty<Api>(`https://127.0.0.1:${lanPort}`, {
    fetch: transport,
    headers: { host: address.host },
  });
  expect(success(await lan[".well-known"].tofu.get()).serverId).toBe(before.server.id);

  await server.stop();
  const restarted = await app.start({ port: Number(new URL(server.url).port) });
  owner = treaty<Api>(restarted.url, { headers: { cookie, origin: restarted.url } }).api;
  const after = success(await owner.connections.get());
  expect(after.config).toEqual(before.config);
  expect(after.exposures.lan.state).toBe("ready");
  expect(success(await lan[".well-known"].tofu.get()).serverId).toBe(before.server.id);

  await restarted.stop();
  const released = Bun.listen({
    hostname: "127.0.0.1",
    port: lanPort,
    socket: { data: () => undefined },
  });
  released.stop();
});
