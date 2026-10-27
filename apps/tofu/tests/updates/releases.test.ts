import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { version } from "../../package.json";
import type { Api } from "../../src/api/index";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { waitFor } from "../helpers/poll";
import { updatesProvider } from "../helpers/updates-provider";

test("update checks publish releases, download installers and reject untrusted redirects", async () => {
  await using upstream = updatesProvider();
  await using app = await application({
    entry: "tests/helpers/updates-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();

  const available = success(await client.updates.check.post());
  expect(available).toMatchObject({
    downloadName: upstream.name,
    latestVersion: "99.0.0",
    status: "available",
  });
  expect(success(await client.updates.get())).toEqual(available);
  expectBytes(await client.updates.download.get(), upstream.bytes);
  expect((await client.updates.prepare.post()).status).toBe(409);
  expect((await client.updates.install.post()).status).toBe(409);

  upstream.state.signedRedirect = true;
  expectBytes(await client.updates.download.get(), upstream.bytes);
  expect(upstream.state.assetHeaders?.get("x-github-api-version")).toBeNull();
  expect(upstream.state.assetHeaders?.get("user-agent")).not.toBe(`Tofu/${version}`);

  upstream.state.invalidRedirect = true;
  const rejected = await client.updates.download.get();
  expect(rejected.status).toBe(502);
  expect(rejected.error?.value).toMatchObject({
    detail: "GitHub returned an invalid download URL",
  });

  upstream.state.missing = true;
  expect(success(await client.updates.check.post()).status).toBe("no-release");
  expect((await client.updates.download.get()).status).toBe(409);
});

test("installer streams release their upstream connection on cancellation and shutdown", async () => {
  await using upstream = updatesProvider();
  await using app = await application({
    entry: "tests/helpers/updates-server.ts",
    provider: upstream.url,
  });
  const { url, stop } = await app.start();
  const client = treaty<Api>(url, {
    onResponse(response) {
      if (response.headers.has("content-disposition")) {
        return response;
      }
    },
  }).api;
  expect(success(await client.updates.check.post()).status).toBe("available");
  upstream.state.streaming = true;

  const cancelled = await client.updates.download.get();
  expect(cancelled.status).toBe(200);
  const reader = cancelled.response.body?.getReader();
  expect((await reader?.read())?.value).toEqual(upstream.bytes);
  await reader?.cancel();
  await waitFor(() => upstream.state.cancelled, Boolean);

  const interrupted = await client.updates.download.get();
  expect(interrupted.status).toBe(200);
  const interruptedReader = interrupted.response.body?.getReader();
  expect((await interruptedReader?.read())?.value).toEqual(upstream.bytes);
  await stop();
  await waitFor(() => upstream.state.cancelled, Boolean);
});

test("update checks report invalid provider data and recover on a valid release", async () => {
  await using upstream = updatesProvider();
  await using app = await application({
    entry: "tests/helpers/updates-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  const release = {
    assets: [{ id: 1, name: upstream.name }],
    draft: false,
    prerelease: false,
    tag_name: "v99.0.0",
  };

  for (const [body, message] of [
    [null, "Invalid GitHub response"],
    [{ ...release, assets: null }, "Invalid GitHub response"],
    [{ ...release, assets: [{ id: 0, name: upstream.name }] }, "Invalid installer list"],
    [{ ...release, assets: [{ id: 1.5, name: upstream.name }] }, "Invalid installer list"],
    [
      { ...release, assets: [{ id: Number.MAX_SAFE_INTEGER + 1, name: upstream.name }] },
      "Invalid installer list",
    ],
    [
      { ...release, tag_name: "v99.0.0-beta.1" },
      "Invalid release version (expected format: v1.2.3)",
    ],
    [{ ...release, tag_name: "v099.0.0" }, "Invalid release version (expected format: v1.2.3)"],
  ] as const) {
    upstream.state.release = body;
    // biome-ignore lint/performance/noAwaitInLoops: Each check must observe its own provider response.
    expect(success(await client.updates.check.post())).toMatchObject({
      error: message,
      status: "error",
    });
    expect((await client.updates.download.get()).status).toBe(409);
  }

  upstream.state.release = { ...release, tag_name: `v${version}` };
  expect(success(await client.updates.check.post())).toMatchObject({
    error: null,
    latestVersion: version,
    status: "current",
  });

  upstream.state.release = release;
  expect(success(await client.updates.check.post())).toMatchObject({
    downloadName: upstream.name,
    error: null,
    latestVersion: "99.0.0",
    status: "available",
  });
});
