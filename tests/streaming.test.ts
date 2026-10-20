import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { expectProblem, expectSuccess } from "./helpers/problem";
import { streamingFixture } from "./helpers/streaming";
import { waitFor } from "./helpers/torrent";

const mib = 1024 * 1024;

test.each(["direct", "worker"])(
  "%s streaming waits for verified pieces without blocking the API or completing the file",
  async (mode) => {
    await using context = await streamingFixture(mode, 16 * mib);
    const { client } = context;
    // Upload metadata without a peer address so every requested piece is initially missing.
    const { id } = expectSuccess(
      await client.torrents.file.post({
        file: new File([new Uint8Array(context.seed.torrentFile)], "episode.torrent"),
        paused: "false",
      })
    );
    await waitFor(
      async () => expectSuccess(await client.torrents({ id }).get()),
      (value) => value.status === "idle"
    );
    expectSuccess(await client.torrents({ id }).files({ index: "0" }).put({ priority: "skip" }));
    await context.api.listen({ hostname: "127.0.0.1", port: 0 });
    const { server } = context.api;
    if (!server) {
      throw new Error("The streaming API did not start listening");
    }
    const listening = treaty<typeof context.api>(`http://127.0.0.1:${server.port}`).api;
    const stream = listening.torrents({ id }).files({ index: "0" }).stream({ name: "episode.bin" });
    const started = performance.now();
    const head = await stream.head();
    expect(head.status).toBe(200);
    expect(new Headers(head.headers).get("content-length")).toBe(String(16 * mib));
    expect(new Headers(head.headers).get("accept-ranges")).toBe("bytes");
    expect(performance.now() - started).toBeLessThan(1000);

    const pending = stream.get({ headers: { range: `bytes=${8 * mib}-${9 * mib - 1}` } });
    // Exercise the listener beyond Bun's former 10-second idle timeout, before any peer joins.
    expect(await Promise.race([pending, Bun.sleep(11_000)])).toBeUndefined();
    const healthStarted = performance.now();
    expectSuccess(await listening.health.get());
    expect(performance.now() - healthStarted).toBeLessThan(1000);
    context.seeder.throttleUpload(mib);
    expectSuccess(
      await client.torrents({ id }).peers.post({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
    );
    const part = await pending;
    expect(part.status).toBe(206);
    expect(new Headers(part.headers).get("content-range")).toBe(
      `bytes ${8 * mib}-${9 * mib - 1}/${16 * mib}`
    );
    expect(new Uint8Array(part.data as unknown as ArrayBuffer)).toEqual(
      new Uint8Array(context.bytes.subarray(8 * mib, 9 * mib))
    );
    const detail = expectSuccess(await client.torrents({ id }).get());
    expect(detail.progress).toBeLessThan(1);
    expect(detail.files[0]?.priority).toBe("skip");

    // Eden buffers binary responses; inspect the raw HTTP body to verify incremental no-Range delivery.
    const controller = new AbortController();
    const first = await fetch(
      `http://127.0.0.1:${server.port}/api/torrents/${id}/files/0/stream/episode.bin`,
      { signal: controller.signal }
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("content-range")).toBeNull();
    const reader = first.body?.getReader();
    if (!reader) {
      throw new Error("Missing incremental response body");
    }
    const chunk = await reader.read();
    expect(chunk.value?.length).toBeGreaterThan(0);
    expect(chunk.value).toEqual(
      new Uint8Array(context.bytes.subarray(0, chunk.value?.length ?? 0))
    );
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      /* Aborting an HTTP reader may reject cancellation. */
    }
    expect(expectSuccess(await client.torrents({ id }).get()).progress).toBeLessThan(1);
    expect((await client.torrents({ id }).files({ index: "0" }).content.get()).status).toBe(409);
  },
  30_000
);

test.each(["direct", "worker"])(
  "%s streaming cancels promptly on pause, removal, and engine shutdown",
  async (mode) => {
    await using context = await streamingFixture(mode, 8 * mib);
    const { client } = context;
    const { id } = expectSuccess(
      await client.torrents.file.post({
        file: new File([new Uint8Array(context.seed.torrentFile)], "episode.torrent"),
        paused: "false",
      })
    );
    await waitFor(
      async () => expectSuccess(await client.torrents({ id }).get()),
      (value) => value.status === "idle"
    );
    const stream = client.torrents({ id }).files({ index: "0" }).stream({ name: "episode.bin" });
    const controller = new AbortController();
    const cancelled = stream.get({
      fetch: { signal: controller.signal },
      headers: { range: "bytes=0-1048575" },
    });
    expect(await Promise.race([cancelled, Bun.sleep(100)])).toBeUndefined();
    controller.abort();
    // A disconnected client has no response contract; its request must settle promptly.
    expect(await Promise.race([cancelled, Bun.sleep(1000)])).toBeDefined();
    const paused = stream.get({ headers: { range: "bytes=0-1048575" } });
    expect(await Promise.race([paused, Bun.sleep(100)])).toBeUndefined();
    const started = performance.now();
    expectSuccess(await client.torrents({ id }).pause.post({}));
    expectProblem(await paused, 499, "Playback stopped");
    expect(performance.now() - started).toBeLessThan(2000);
    expectProblem(await stream.get(), 409, "Resume this torrent to play it");
    expect((await stream.head()).status).toBe(200);
    expectSuccess(await client.torrents({ id }).resume.post({}));
    await waitFor(
      async () => expectSuccess(await client.torrents({ id }).get()),
      (value) => value.status === "idle"
    );
    const removed = stream.get({ headers: { range: "bytes=0-1048575" } });
    expect(await Promise.race([removed, Bun.sleep(100)])).toBeUndefined();
    expectSuccess(await client.torrents({ id }).delete({ deleteFiles: false }));
    expectProblem(await removed, 499, "Playback stopped");
    const added = expectSuccess(
      await client.torrents.file.post({
        file: new File([new Uint8Array(context.seed.torrentFile)], "episode.torrent"),
        paused: "false",
      })
    );
    await waitFor(
      async () => expectSuccess(await client.torrents({ id: added.id }).get()),
      (value) => value.status === "idle"
    );
    const closing = client
      .torrents({ id: added.id })
      .files({ index: "0" })
      .stream({ name: "episode.bin" })
      .get({ headers: { range: "bytes=0-1048575" } });
    expect(await Promise.race([closing, Bun.sleep(100)])).toBeUndefined();
    const closeStarted = performance.now();
    await context.engine.close();
    expect(performance.now() - closeStarted).toBeLessThan(3000);
    expectProblem(await closing, 499, "Playback stopped");
  },
  30_000
);
