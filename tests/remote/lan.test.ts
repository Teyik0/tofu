import { expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { openDatabase } from "../../src/api/lib/db";
import { resolveInstanceConfig } from "../../src/api/lib/instance";
import { connectionState } from "../../src/db/schema";
import { expectSuccess } from "../helpers/problem";
import { freePort, redemptionNonce, remoteServerFixture, sessionCookie } from "../helpers/remote";
import { launchServer } from "../helpers/server-process";
import { fakeTailscale } from "../helpers/tailscale";
import { waitFor } from "../helpers/torrent";

/** A local network name covered by the installation certificate; the test connects to loopback. */
const name = "tofu-test.home.arpa";
const tailnetHost = "home.tail-test.ts.net";
const tailnetOrigin = `https://${tailnetHost}`;

test("local network HTTPS and Tailscale serve one library and identity side by side, and each turns off alone", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "tofu-lan-tailscale-"));
  const tailscale = await fakeTailscale(scratch, {});
  const previous = process.env.TOFU_TAILSCALE_CLI;
  process.env.TOFU_TAILSCALE_CLI = tailscale.cli;
  try {
    await using context = await remoteServerFixture(64 * 1024);
    const owner = treaty<Api>(context.url).api;
    const added = expectSuccess(
      await owner.torrents.file.post({
        file: new File([new Uint8Array(context.seed.torrentFile)], "show.torrent"),
        paused: "false",
      })
    );
    expectSuccess(
      await owner.torrents({ id: added.id }).peers.post({
        peer: `127.0.0.1:${context.seeder.torrentPort}`,
      })
    );
    await context.complete(added.id);

    const lanPort = freePort();
    const lanHost = `${name}:${lanPort}`;
    const lanOrigin = `https://${lanHost}`;
    expectSuccess(
      await owner.connections.put({
        enabled: false,
        lanHostnames: [name],
        lanPort,
        transport: "lan",
      })
    );
    expectSuccess(await owner.connections.certificate.post());
    // A name added after the certificate was created is neither offered nor served.
    expectSuccess(
      await owner.connections.put({
        enabled: false,
        lanHostnames: [name, "later.home.arpa"],
        transport: "lan",
      })
    );
    const ca = await Bun.file(join(context.config.dataDir, "tls/ca.pem")).text();
    const [lanInvitation, tailnetInvitation] = (
      await Promise.all(
        ["Living room", "Laptop"].map((label) =>
          owner.access.invitations.post({
            canDeleteFiles: false,
            expiresInMinutes: 10,
            label,
            role: "playback",
          })
        )
      )
    ).map(expectSuccess);
    if (!(lanInvitation && tailnetInvitation)) {
      throw new Error("Two invitations are required");
    }

    const enabled = await owner.connections.put({ enabled: true, transport: "lan" });
    expectSuccess(enabled);
    const admin = treaty<Api>(context.url, {
      headers: { cookie: sessionCookie(enabled.response), origin: context.url },
    }).api;
    expectSuccess(await admin.connections.put({ enabled: true, transport: "tailscale" }));
    const state = expectSuccess(await admin.connections.get());
    expect(state.exposures).toEqual({
      lan: { detail: null, state: "ready" },
      proxy: { detail: null, state: "off" },
      tailscale: { detail: null, state: "ready" },
    });
    // The application stays on loopback HTTP; the public port belongs to the ingress.
    expect(state.listening.port).toBe(Number(new URL(context.url).port));
    expect(state.listening.port).not.toBe(lanPort);
    expect(state.addresses).toContain(lanOrigin);
    expect(
      state.addresses.filter((address) =>
        ["later.home.arpa", "localhost", "127.0.0.1", "[::1]"].includes(new URL(address).hostname)
      )
    ).toEqual([]);
    expect((await tailscale.read()).serve).toEqual({
      TCP: { 443: { HTTPS: true } },
      Web: {
        [`${tailnetHost}:443`]: {
          Handlers: { "/": { Proxy: `http://127.0.0.1:${state.listening.port}` } },
        },
      },
    });
    // Local network sharing never enrolls the embedded private network.
    expect(await readdir(join(context.config.dataDir, "tailscale"))).toEqual([]);

    // Browsers reach the ingress by name; the test resolves that name to loopback.
    const lanBase = `https://127.0.0.1:${lanPort}`;
    const lanFetch = { cache: "no-store", tls: { ca, serverName: name } } as RequestInit;
    const lan = treaty<Api>(lanBase, {
      fetch: lanFetch,
      headers: { host: lanHost, origin: lanOrigin },
    }).api;
    // Tailscale Serve forwards to the loopback listener with the tailnet host.
    const tailnet = treaty<Api>(context.url, {
      headers: { host: tailnetHost, origin: tailnetOrigin },
    }).api;
    const lanPaired = await lan.auth.pair.post({
      kind: "browser",
      label: "Living room",
      nonce: redemptionNonce(),
      secret: lanInvitation.secret,
    });
    expectSuccess(lanPaired);
    const lanCookie = sessionCookie(lanPaired.response);
    expect(lanCookie).toStartWith("__Host-tofu-");
    // Invitations stay single-use across addresses; each address pairs separately.
    expect(
      (
        await tailnet.auth.pair.post({
          kind: "browser",
          label: "Laptop",
          nonce: redemptionNonce(),
          secret: lanInvitation.secret,
        })
      ).status
    ).toBe(410);
    const tailnetPaired = await tailnet.auth.pair.post({
      kind: "browser",
      label: "Laptop",
      nonce: redemptionNonce(),
      secret: tailnetInvitation.secret,
    });
    expectSuccess(tailnetPaired);
    const lanClient = treaty<Api>(lanBase, {
      fetch: lanFetch,
      headers: { cookie: lanCookie, host: lanHost, origin: lanOrigin },
    }).api;
    const tailnetClient = treaty<Api>(context.url, {
      headers: {
        cookie: sessionCookie(tailnetPaired.response),
        host: tailnetHost,
        origin: tailnetOrigin,
      },
    }).api;
    const lanSession = expectSuccess(await lanClient.session.get());
    const tailnetSession = expectSuccess(await tailnetClient.session.get());
    expect(lanSession.server.id).toBe(tailnetSession.server.id);
    expect(lanSession.caller.role).toBe("playback");
    expect(expectSuccess(await lanClient.state.get()).torrents.map((item) => item.id)).toEqual(
      expectSuccess(await tailnetClient.state.get()).torrents.map((item) => item.id)
    );

    // Hosts outside the certificate's served names never reach Tofu.
    for (const host of [
      `evil.example:${lanPort}`,
      `later.home.arpa:${lanPort}`,
      `localhost:${lanPort}`,
      `127.0.0.1:${lanPort}`,
      `${name}:${lanPort}0`,
      `${name}:0${lanPort}`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each refused host is checked separately.
      const refused = await treaty<Api>(lanBase, { fetch: lanFetch, headers: { host } })[
        ".well-known"
      ].tofu.get();
      expect(refused.status).toBe(421);
    }
    // Forwarding headers from a browser are replaced by the ingress: a request claiming the
    // Tailscale address remains a local network request, so only its own origin is accepted.
    const spoofed = {
      forwarded: `host=${tailnetHost};proto=https`,
      "x-forwarded-host": tailnetHost,
      "x-forwarded-proto": "https",
    };
    const mediaKey = `${added.id}:0:${64 * 1024}`;
    expectSuccess(
      await lanClient.playback
        .positions({ mediaKey })
        .put({ duration: 100, position: 10, sequence: 1, sessionId: "lan" }, { headers: spoofed })
    );
    expect(
      (
        await lanClient.playback
          .positions({ mediaKey })
          .put(
            { duration: 100, position: 20, sequence: 2, sessionId: "lan" },
            { headers: { ...spoofed, origin: tailnetOrigin } }
          )
      ).status
    ).toBe(403);

    // Media ranges stream through the ingress byte for byte.
    const [file] = expectSuccess(await lanClient.torrents({ id: added.id }).get()).files;
    if (!file) {
      throw new Error("The torrent has no file");
    }
    const media = `${lanBase}/api/torrents/${added.id}/files/0/stream/${encodeURIComponent(file.name)}`;
    const part = await fetch(media, {
      ...lanFetch,
      headers: { cookie: lanCookie, host: lanHost, range: "bytes=100-4195" },
    });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(context.bytes.subarray(100, 4196));

    // Turning Tailscale off removes Tofu's mapping and keeps the local network.
    expectSuccess(await admin.connections.put({ enabled: false, transport: "tailscale" }));
    expect((await tailscale.read()).serve).toEqual({});
    expect((await tailnetClient.session.get()).status).toBe(403);
    expectSuccess(await lanClient.session.get());

    // Revocation ends the device's live stream through the ingress.
    const live = await fetch(`${lanBase}/api/live`, {
      ...lanFetch,
      headers: { cookie: lanCookie, host: lanHost },
    });
    const reader = live.body?.getReader();
    if (!reader) {
      throw new Error("Missing live stream");
    }
    await reader.read();
    const ended = (async () => {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Read until the server ends the stream.
        while (!(await reader.read()).done) {
          // Snapshots sent before revocation are discarded.
        }
      } catch {
        // An aborted stream also ended.
      }
      return true;
    })();
    const device = expectSuccess(await admin.access.devices.get()).find(
      (item) => item.label === "Living room"
    );
    if (!device) {
      throw new Error("The local network device is missing");
    }
    expectSuccess(await admin.access.devices({ id: device.id }).delete());
    expect(await Promise.race([ended, Bun.sleep(2000)])).toBe(true);
    expect((await lanClient.session.get()).status).toBe(401);

    // Turning the local network off closes its port; sharing is now off entirely.
    expectSuccess(await admin.connections.put({ enabled: false, transport: "lan" }));
    expect(
      await (async () => {
        try {
          await fetch(`${lanBase}/.well-known/tofu`, { ...lanFetch, headers: { host: lanHost } });
          return "reachable";
        } catch {
          return "closed";
        }
      })()
    ).toBe("closed");
    const off = expectSuccess(await admin.connections.get());
    expect(off.enabled).toBe(false);
    expect(off.addresses).toEqual([]);
    expect(await readdir(join(context.config.dataDir, "tailscale"))).toEqual([]);
  } finally {
    if (previous === undefined) {
      delete process.env.TOFU_TAILSCALE_CLI;
    } else {
      process.env.TOFU_TAILSCALE_CLI = previous;
    }
    await rm(scratch, { force: true, recursive: true });
  }
}, 90_000);

test("an exclusive local network configuration from an earlier version keeps its address and advertises its public port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-lan-migration-"));
  const config = resolveInstanceConfig({
    dataDir: join(directory, "state"),
    desktop: false,
    downloadPath: join(directory, "downloads"),
    homeDir: directory,
    platform: process.platform,
    port: "0",
    profile: "dev",
  });
  // macOS advertises with dns-sd; this one records its arguments at the CLI boundary.
  const advertised = join(directory, "dns-sd.txt");
  await Bun.write(
    join(directory, "bin/dns-sd"),
    `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(advertised)}\nexec sleep 60\n`
  );
  await chmod(join(directory, "bin/dns-sd"), 0o755);
  const first = launchServer(config);
  let secret = "";
  try {
    const owner = treaty<Api>(await first.ready()).api;
    expectSuccess(
      await owner.connections.put({ enabled: false, lanHostnames: [name], transport: "lan" })
    );
    expectSuccess(await owner.connections.certificate.post());
    ({ secret } = expectSuccess(
      await owner.access.invitations.post({
        canDeleteFiles: false,
        expiresInMinutes: 10,
        label: "Upgraded",
        role: "administration",
      })
    ));
  } finally {
    await first.stop();
  }
  // The data directory of an earlier version: one exclusive transport, the LAN on its own port.
  const lanPort = freePort();
  const legacy = JSON.stringify({
    enabled: true,
    lanHostnames: [name],
    port: lanPort,
    proxyOrigin: "https://proxy.example.test",
    tailscaleOrigin: null,
    transport: "lan",
    trustedProxies: ["192.0.2.10"],
  });
  const database = await openDatabase(config.dataDir);
  try {
    for (const key of ["active", "last-good"]) {
      database
        .insert(connectionState)
        .values({ key, updatedAt: Date.now(), value: legacy })
        .onConflictDoUpdate({ set: { value: legacy }, target: connectionState.key })
        .run();
    }
  } finally {
    database.$client.close(true);
  }
  const upgraded = launchServer(config, undefined, undefined, {
    PATH: `${join(directory, "bin")}:${process.env.PATH}`,
    TOFU_DISCOVERY: "1",
  });
  try {
    const application = new URL(await upgraded.ready());
    expect(application.protocol).toBe("http:");
    expect(application.port).not.toBe(String(lanPort));
    const ca = await Bun.file(join(config.dataDir, "tls/ca.pem")).text();
    const lanBase = `https://127.0.0.1:${lanPort}`;
    const lanFetch = { cache: "no-store", tls: { ca, serverName: name } } as RequestInit;
    const lanHost = `${name}:${lanPort}`;
    const paired = await treaty<Api>(lanBase, {
      fetch: lanFetch,
      headers: { host: lanHost, origin: `https://${lanHost}` },
    }).api.auth.pair.post({ kind: "browser", label: "Upgraded", nonce: redemptionNonce(), secret });
    expectSuccess(paired);
    const admin = treaty<Api>(lanBase, {
      fetch: lanFetch,
      headers: {
        cookie: sessionCookie(paired.response),
        host: lanHost,
        origin: `https://${lanHost}`,
      },
    }).api;
    const state = expectSuccess(await admin.connections.get());
    expect(state.config.lan).toEqual({ enabled: true, hostnames: [name], port: lanPort });
    expect(state.config.proxy).toEqual({
      enabled: false,
      origin: "https://proxy.example.test",
      trustedProxies: ["192.0.2.10"],
    });
    expect(state.config.tailscale.enabled).toBe(false);
    expect(state.exposures.lan.state).toBe("ready");
    expect(state.listening.port).toBe(Number(application.port));
    expect(await readdir(join(config.dataDir, "tailscale"))).toEqual([]);
    if (process.platform === "darwin") {
      const record = await waitFor(
        async () =>
          (await Bun.file(advertised).exists()) ? await Bun.file(advertised).text() : "",
        (text) => text.length > 0
      );
      // Discovery points devices at the public HTTPS port, never at the private listener.
      expect(record.split(" ")).toContain(String(lanPort));
      expect(record.split(" ")).not.toContain(application.port);
    }
  } finally {
    await upgraded.stop();
    await rm(directory, { force: true, recursive: true });
  }
}, 60_000);

test("exposure changes apply one at a time, a refused port keeps the previous ingress, and a failed startup releases the companion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-lan-lifecycle-"));
  // A private copy of the companion identifies this test's process.
  const companion = join(
    directory,
    process.platform === "win32" ? "tofu-tsnet-lifecycle.exe" : "tofu-tsnet-lifecycle"
  );
  await copyFile(
    join(
      import.meta.dir,
      "../../runtime",
      process.platform === "win32" ? "tofu-tsnet.exe" : "tofu-tsnet"
    ),
    companion
  );
  await chmod(companion, 0o755);
  const environment = { TOFU_TSNET_BINARY: companion };
  const config = resolveInstanceConfig({
    dataDir: join(directory, "state"),
    desktop: false,
    downloadPath: join(directory, "downloads"),
    homeDir: directory,
    platform: process.platform,
    port: "0",
    profile: "dev",
  });
  const server = launchServer(config, undefined, undefined, environment);
  const lanPort = freePort();
  const occupied = Bun.listen({
    hostname: "0.0.0.0",
    port: 0,
    socket: {
      data() {
        // Holds the port; nothing is read.
      },
    },
  });
  try {
    const url = await server.ready();
    const owner = treaty<Api>(url).api;
    expectSuccess(
      await owner.connections.put({
        enabled: false,
        lanHostnames: [name],
        lanPort,
        transport: "lan",
      })
    );
    expectSuccess(await owner.connections.certificate.post());
    // Both changes were admitted for the owner and apply one after the other; neither is lost.
    const changes = await Promise.all([
      owner.connections.put({ enabled: true, transport: "lan" }),
      owner.connections.put({
        enabled: true,
        proxyOrigin: "https://proxy.example.test",
        transport: "proxy",
      }),
    ]);
    for (const change of changes) {
      expectSuccess(change);
    }
    const cookie = changes
      .map((change) => change.response.headers.get("set-cookie")?.split(";")[0])
      .find(Boolean);
    const admin = treaty<Api>(url, { headers: { cookie: cookie ?? "", origin: url } }).api;
    const state = expectSuccess(await admin.connections.get());
    expect(state.config.lan.enabled).toBe(true);
    expect(state.config.proxy.enabled).toBe(true);

    const ca = await Bun.file(join(config.dataDir, "tls/ca.pem")).text();
    const lanFetch = { cache: "no-store", tls: { ca, serverName: name } } as RequestInit;
    const descriptor = () =>
      treaty<Api>(`https://127.0.0.1:${lanPort}`, {
        fetch: lanFetch,
        headers: { host: `${name}:${lanPort}` },
      })[".well-known"].tofu.get();
    expectSuccess(await descriptor());
    // A port another program uses is refused, and the previous ingress keeps serving.
    const refused = await admin.connections.put({
      enabled: true,
      lanPort: occupied.port,
      transport: "lan",
    });
    expect(refused.status).toBe(503);
    expect(refused.error?.value).toMatchObject({ detail: expect.stringContaining("in use") });
    const kept = expectSuccess(await admin.connections.get());
    expect(kept.config.lan.port).toBe(lanPort);
    expect(kept.exposures.lan.state).toBe("ready");
    expectSuccess(await descriptor());
    // Tofu's own port cannot become the public port.
    expect(
      (
        await admin.connections.put({
          enabled: true,
          lanPort: kept.listening.port,
          transport: "lan",
        })
      ).status
    ).toBe(400);
  } finally {
    await server.stop();
  }
  // A required exposure that cannot open prevents startup and releases what was started.
  const blocker = Bun.listen({
    hostname: "0.0.0.0",
    port: lanPort,
    socket: {
      data() {
        // Holds the port; nothing is read.
      },
    },
  });
  try {
    const failed = launchServer(config, undefined, undefined, environment);
    expect(await failed.child.exited).not.toBe(0);
    expect(await failed.output).toContain("already in use");
    expect(await Bun.file(join(config.dataDir, "server.json")).exists()).toBe(false);
    if (process.platform !== "win32") {
      const processes = Bun.spawnSync(["ps", "-axo", "command"]).stdout.toString();
      expect(processes).not.toContain(companion);
    }
  } finally {
    blocker.stop(true);
  }
  const recovered = launchServer(config, undefined, undefined, environment);
  try {
    await recovered.ready();
    const ca = await Bun.file(join(config.dataDir, "tls/ca.pem")).text();
    expectSuccess(
      await treaty<Api>(`https://127.0.0.1:${lanPort}`, {
        fetch: { cache: "no-store", tls: { ca, serverName: name } } as RequestInit,
        headers: { host: `${name}:${lanPort}` },
      })[".well-known"].tofu.get()
    );
  } finally {
    await recovered.stop();
    occupied.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
}, 90_000);
