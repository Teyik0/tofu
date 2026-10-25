import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { updatesProvider } from "../helpers/updates-provider";

test("update checks publish releases, download installers and reject untrusted redirects", async () => {
  await using upstream = updatesProvider();
  await using app = await application({ provider: upstream.url });
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
