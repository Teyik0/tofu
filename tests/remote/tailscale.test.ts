import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import { resolveInstanceConfig } from "../../src/api/lib/instance";
import { expectSuccess } from "../helpers/problem";
import { launchServer } from "../helpers/server-process";
import { fakeTailscale } from "../helpers/tailscale";

test("Tofu creates and removes only its exact Tailscale Serve mapping and never touches Funnel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-tailscale-"));
  const tailscale = await fakeTailscale(directory, {});
  const config = resolveInstanceConfig({
    dataDir: join(directory, "state"),
    desktop: false,
    downloadPath: join(directory, "downloads"),
    homeDir: directory,
    platform: process.platform,
    port: "0",
    profile: "dev",
  });
  const previous = process.env.TOFU_TAILSCALE_CLI;
  process.env.TOFU_TAILSCALE_CLI = tailscale.cli;
  const server = launchServer(config);
  try {
    const url = await server.ready();
    const { port } = new URL(url);
    const owner = treaty<Api>(url).api;
    const checked = expectSuccess(await owner.connections.tailscale.check.post());
    expect(checked).toEqual({ origin: "https://home.tail-test.ts.net", state: "available" });
    const enabled = await owner.connections.put({ enabled: true, transport: "tailscale" });
    expect(enabled.status).toBe(200);
    expect((await tailscale.read()).serve).toEqual({
      TCP: { 443: { HTTPS: true } },
      Web: {
        "home.tail-test.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } },
      },
    });
    const admin = treaty<Api>(url, {
      headers: {
        cookie: enabled.response.headers.get("set-cookie")?.split(";")[0] ?? "",
        origin: url,
      },
    }).api;
    expect(expectSuccess(await admin.connections.get()).config.tailscale.origin).toBe(
      "https://home.tail-test.ts.net"
    );
    // Turning remote access off removes the mapping Tofu created, and nothing else.
    expectSuccess(await admin.connections.put({ enabled: false, transport: "tailscale" }));
    const { calls, serve } = await tailscale.read();
    expect(serve).toEqual({});
    expect(calls.filter((call) => !call.includes("status"))).toEqual([
      `serve --bg --https=443 http://127.0.0.1:${port}`,
      "serve --https=443 off",
    ]);
    expect(calls.some((call) => call.includes("funnel"))).toBe(false);
  } finally {
    await server.stop();
    if (previous === undefined) {
      delete process.env.TOFU_TAILSCALE_CLI;
    } else {
      process.env.TOFU_TAILSCALE_CLI = previous;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("another HTTPS service on the Tailscale address is a conflict Tofu leaves untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-tailscale-"));
  const foreign = {
    TCP: { 443: { HTTPS: true } },
    Web: { "home.tail-test.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } },
  };
  const tailscale = await fakeTailscale(directory, foreign);
  const config = resolveInstanceConfig({
    dataDir: join(directory, "state"),
    desktop: false,
    downloadPath: join(directory, "downloads"),
    homeDir: directory,
    platform: process.platform,
    port: "0",
    profile: "dev",
  });
  const previous = process.env.TOFU_TAILSCALE_CLI;
  process.env.TOFU_TAILSCALE_CLI = tailscale.cli;
  const server = launchServer(config);
  try {
    const owner = treaty<Api>(await server.ready()).api;
    expect(expectSuccess(await owner.connections.tailscale.check.post()).state).toBe("conflict");
    expect((await owner.connections.put({ enabled: true, transport: "tailscale" })).status).toBe(
      409
    );
    const { calls, serve } = await tailscale.read();
    expect(serve).toEqual(foreign);
    expect(calls.every((call) => call.includes("status"))).toBe(true);
    // Remote access stays off after the refused change.
    expect(expectSuccess(await owner.session.get()).remoteAccess.enabled).toBe(false);
  } finally {
    await server.stop();
    if (previous === undefined) {
      delete process.env.TOFU_TAILSCALE_CLI;
    } else {
      process.env.TOFU_TAILSCALE_CLI = previous;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("an identical pre-existing Serve mapping is usable but never becomes Tofu-owned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-tailscale-"));
  const tailscale = await fakeTailscale(directory, {});
  const config = resolveInstanceConfig({
    dataDir: join(directory, "state"),
    desktop: false,
    downloadPath: join(directory, "downloads"),
    homeDir: directory,
    platform: process.platform,
    port: "0",
    profile: "dev",
  });
  const previous = process.env.TOFU_TAILSCALE_CLI;
  process.env.TOFU_TAILSCALE_CLI = tailscale.cli;
  const server = launchServer(config);
  try {
    const url = await server.ready();
    const existing = {
      TCP: { 443: { HTTPS: true } },
      Web: { "home.tail-test.ts.net:443": { Handlers: { "/": { Proxy: url } } } },
    };
    await tailscale.configure(existing);
    const owner = treaty<Api>(url).api;
    const enabled = await owner.connections.put({ enabled: true, transport: "tailscale" });
    expectSuccess(enabled);
    const admin = treaty<Api>(url, {
      headers: {
        cookie: enabled.response.headers.get("set-cookie")?.split(";")[0] ?? "",
        origin: url,
      },
    }).api;
    expect(expectSuccess(await admin.connections.get()).config.tailscale.serveOwned).toBe(false);
    expectSuccess(await admin.connections.put({ enabled: false, transport: "tailscale" }));
    expect((await tailscale.read()).serve).toEqual(existing);
    expect((await tailscale.read()).calls.every((call) => call.includes("status"))).toBe(true);
  } finally {
    await server.stop();
    if (previous === undefined) {
      delete process.env.TOFU_TAILSCALE_CLI;
    } else {
      process.env.TOFU_TAILSCALE_CLI = previous;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
