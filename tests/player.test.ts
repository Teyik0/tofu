import { expect, test } from "bun:test";
import { version } from "libvlc-wasm/package.json";
import { expectSuccess } from "./helpers/problem";
import { fixture, waitFor } from "./helpers/torrent";

test("the player streams completed files by range and serves its engine in isolation", async () => {
  await using resources = new AsyncDisposableStack();
  const length = 6 * 1024 * 1024;
  const context = await fixture(length, [], "episode.bin");
  resources.defer(context.close);
  const { id } = expectSuccess(
    await context.client.torrents.post({ paused: false, source: context.magnet })
  );
  await waitFor(
    async () => expectSuccess(await context.client.torrents({ id }).get()),
    (detail) => detail.status === "seeding"
  );
  const stream = context.client
    .torrents({ id })
    .files({ index: "0" })
    .stream({ name: "episode.bin" });

  const head = await stream.head();
  expect(head.status).toBe(200);
  expect(new Headers(head.headers).get("accept-ranges")).toBe("bytes");
  expect(new Headers(head.headers).get("content-length")).toBe(String(length));

  const part = await stream.get({ headers: { range: "bytes=1000-1999" } });
  expect(part.status).toBe(206);
  expect(new Headers(part.headers).get("content-range")).toBe(`bytes 1000-1999/${length}`);
  // Ranged responses carry binary data with a 206 status.
  expect(part.data).toBeInstanceOf(ArrayBuffer);
  expect(new Uint8Array(part.data as unknown as ArrayBuffer)).toEqual(
    new Uint8Array(context.bytes.subarray(1000, 2000))
  );
  const tail = await stream.get({ headers: { range: "bytes=-100" } });
  expect(new Uint8Array(tail.data as unknown as ArrayBuffer)).toEqual(
    new Uint8Array(context.bytes.subarray(length - 100))
  );
  const window = await stream.get({ headers: { range: "bytes=0-" } });
  expect(window.status).toBe(206);
  expect(new Headers(window.headers).get("content-length")).toBe(String(4 * 1024 * 1024));
  expect(new Uint8Array(window.data as unknown as ArrayBuffer)).toEqual(
    new Uint8Array(context.bytes.subarray(0, 4 * 1024 * 1024))
  );
  const outside = await stream.get({ headers: { range: `bytes=${length}-` } });
  expect(outside.status).toBe(416);
  expect(new Headers(outside.headers).get("content-range")).toBe(`bytes */${length}`);

  // The engine route has a wildcard path, which the typed client cannot express.
  const engine = `http://localhost/api/player/engine/${version}`;
  const font = `${engine}/fonts/NotoSans-Regular.ttf`;
  const [engineHead, engineGet] = await Promise.all([
    context.api.handle(new Request(font, { method: "HEAD" })),
    context.api.handle(new Request(font)),
  ]);
  for (const response of [engineHead, engineGet]) {
    expect(response.status).toBe(200);
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  }
  expect(Number(engineHead.headers.get("content-length"))).toBeGreaterThan(0);
  expect((await engineGet.arrayBuffer()).byteLength).toBe(
    Number(engineHead.headers.get("content-length"))
  );
  const rejected = await Promise.all(
    [`${engine}/../../package.json`, "http://localhost/api/player/engine/0.0.0/src/index.js"].map(
      (path) => context.api.handle(new Request(path))
    )
  );
  expect(rejected.map((response) => response.status)).toEqual([404, 404]);
  // Only the player is cross-origin isolated, so the library can still show remote images.
  const state = await context.api.handle(new Request("http://localhost/api/state"));
  expect(state.headers.get("cross-origin-embedder-policy")).toBeNull();
}, 30_000);
