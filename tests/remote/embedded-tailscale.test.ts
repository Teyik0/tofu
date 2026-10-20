import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { resolveInstanceConfig } from "../../src/api/lib/instance";
import { embeddedTailscaleFixture } from "../helpers/embedded-tailscale";
import { expectSuccess } from "../helpers/problem";
import { launchServer } from "../helpers/server-process";

test("embedded enrollment reports missing HTTPS and applying succeeds after tailnet HTTPS is enabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-embedded-tailscale-"));
  const fixture = await embeddedTailscaleFixture(directory);
  const previous = process.env.TOFU_TSNET_BINARY;
  process.env.TOFU_TSNET_BINARY = fixture.binary;
  const server = launchServer(
    resolveInstanceConfig({
      dataDir: join(directory, "state"),
      desktop: false,
      downloadPath: join(directory, "downloads"),
      homeDir: directory,
      platform: process.platform,
      port: "0",
      profile: "dev",
    })
  );
  try {
    const origin = await server.ready();
    const owner = treaty<Api>(origin).api;
    const enrolled = expectSuccess(await owner.connections.tailscale.enroll.post());
    expect(enrolled.state).toBe("Running");
    expect(enrolled.httpsEnabled).toBe(false);
    const approval = expectSuccess(await owner.connections.tailscale.https.post());
    expect(approval.approvalUrl).toBe("https://console.tailscale.com/admin/dns");
    expect(approval.httpsEnabled).toBe(false);
    const refused = await owner.connections.put({
      enabled: true,
      tailscaleMode: "embedded",
      transport: "tailscale",
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.value).toMatchObject({
      detail: expect.stringContaining("DNS → HTTPS Certificates → Enable HTTPS"),
    });
    expect(expectSuccess(await owner.connections.get()).config.enabled).toBe(false);
    await Bun.write(fixture.configuration, JSON.stringify({ httpsEnabled: true }));
    expect(expectSuccess(await owner.connections.tailscale.embedded.get()).httpsEnabled).toBe(true);
    const applied = await owner.connections.put({
      enabled: true,
      tailscaleMode: "embedded",
      transport: "tailscale",
    });
    expectSuccess(applied);
    const admin = treaty<Api>(origin, {
      headers: {
        cookie: applied.response.headers.get("set-cookie")?.split(";")[0] ?? "",
        origin,
      },
    }).api;
    const active = expectSuccess(await admin.connections.get());
    expect(active.config.enabled).toBe(true);
    expect(active.config.tailscaleOrigin).toBe("https://tofu.tail-test.ts.net");
    expectSuccess(
      await admin.connections.put({
        enabled: false,
        tailscaleMode: "embedded",
        transport: "tailscale",
      })
    );
  } finally {
    await server.stop();
    if (previous === undefined) {
      delete process.env.TOFU_TSNET_BINARY;
    } else {
      process.env.TOFU_TSNET_BINARY = previous;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
