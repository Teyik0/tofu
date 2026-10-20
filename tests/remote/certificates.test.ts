import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../../src/api";
import type { ServerInfo } from "../../src/types";
import { launchNativeUpdateHost } from "../helpers/native-update-host";
import { expectProblem, expectSuccess } from "../helpers/problem";
import { remoteServerFixture } from "../helpers/remote";

test("the owner creates, reads, downloads and renews the local certificate while preserving its CA", async () => {
  await using context = await remoteServerFixture(4096);
  const client = treaty<Api>(context.url).api;
  expect(expectSuccess(await client.connections.certificate.get()).certificate).toBeNull();
  expectProblem(
    await client.connections.certificate.download.get(),
    404,
    "Create the local network certificate first"
  );
  const created = expectSuccess(await client.connections.certificate.post());
  expect(expectSuccess(await client.connections.certificate.get()).certificate).toEqual(created);
  const download = await client.connections.certificate.download.get();
  const pem = expectSuccess(download);
  expect(download.response.headers.get("content-disposition")).toBe(
    'attachment; filename="Tofu-CA.pem"'
  );
  expect(new X509Certificate(pem).fingerprint256).toBe(created.fingerprint);
  expect(pem).not.toContain("PRIVATE KEY");
  const leaf = await Bun.file(join(context.config.dataDir, "tls/server.pem")).text();
  const renewed = expectSuccess(await client.connections.certificate.post());
  expect(renewed.fingerprint).toBe(created.fingerprint);
  expect(await Bun.file(join(context.config.dataDir, "tls/server.pem")).text()).not.toBe(leaf);
  expect(expectSuccess(await client.connections.certificate.download.get())).toBe(pem);
  expectProblem(
    await client.connections.certificate.download.post(),
    409,
    "Use the browser download to save the installation CA"
  );
}, 30_000);

test("the native owner exports only the public CA through the directory dialog and can cancel safely", async () => {
  await using resources = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), "tofu-native-certificates-"));
  resources.defer(() => rm(directory, { force: true, recursive: true }));
  const dataDir = join(directory, "native-state");
  const selection = join(directory, "selection.json");
  const folder = join(directory, "exports");
  await mkdir(folder);
  await Bun.write(selection, JSON.stringify([folder]));
  const host = await launchNativeUpdateHost({
    dataDir,
    directory,
    directorySelectionFile: selection,
    downloadPath: join(directory, "native-downloads"),
    handoff: "success",
    magnet: `magnet:?xt=urn:btih:${"0".repeat(40)}`,
  });
  try {
    await host.ready;
    const info = (await Bun.file(join(dataDir, "server.json")).json()) as ServerInfo;
    const client = treaty<Api>(info.url, { headers: { cookie: info.cookie ?? "" } }).api;
    expect((await treaty<Api>(info.url).api.connections.certificate.download.post()).status).toBe(
      403
    );
    expectProblem(
      await client.connections.certificate.download.post(),
      404,
      "Create the local network certificate first"
    );
    const certificate = expectSuccess(await client.connections.certificate.post());
    const path = join(folder, "Tofu-CA.pem");
    expect(expectSuccess(await client.connections.certificate.download.post())).toEqual({ path });
    const pem = await Bun.file(path).text();
    expect(new X509Certificate(pem).fingerprint256).toBe(certificate.fingerprint);
    expect(pem).not.toContain("PRIVATE KEY");
    expect(expectSuccess(await client.connections.certificate.download.post())).toEqual({ path });
    await Bun.write(path, "Keep this existing file");
    expectProblem(
      await client.connections.certificate.download.post(),
      409,
      "A different Tofu-CA.pem already exists in this folder. Choose another folder"
    );
    expect(await Bun.file(path).text()).toBe("Keep this existing file");
    await Bun.write(selection, "[]");
    expect(expectSuccess(await client.connections.certificate.download.post())).toEqual({
      path: null,
    });
  } finally {
    await host.stop();
  }
}, 60_000);
