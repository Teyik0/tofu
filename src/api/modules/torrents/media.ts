import { createLogger } from "evlog";
import "@teyik0/furin/server-only";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { type Context, ElysiaStatus, problem } from "elysia";
import { sanitizeLog } from "../../lib/diagnostics";
import type { EnginePort } from "./service";

const CHUNK = 256 * 1024;
const RANGE_LIMIT = 4 * 1024 * 1024;
const byteRange = /^bytes=(\d*)-(\d*)$/;
const PER_CALLER = 4;
const GLOBAL = 16;

/**
 * Admission for media reads: bounded per caller and globally so slow or numerous clients cannot
 * exhaust memory, descriptors or torrent waits. Reserve synchronously before the first await.
 */
export class MediaReaders {
  private active = 0;
  private readonly callers = new Map<string, number>();

  reserve(key: string) {
    const count = this.callers.get(key) ?? 0;
    if (count >= PER_CALLER || this.active >= GLOBAL) {
      return null;
    }
    this.callers.set(key, count + 1);
    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      const remaining = (this.callers.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.callers.set(key, remaining);
      } else {
        this.callers.delete(key);
      }
    };
  }
}

export const mediaReaders = new MediaReaders();

/**
 * Streams `[start, end]` from one opened descriptor. The descriptor is checked once against the
 * expected identity, then reused for every chunk, so a replaced path cannot change the bytes.
 * Aborting `signal` (disconnect, revocation, shutdown) stops further bytes and closes the file.
 */
export async function openMediaStream(options: {
  end: number;
  minimumSize: number;
  identity: { dev: number; ino: number };
  beforeRead?: (start: number, end: number) => Promise<boolean>;
  path: string;
  release: () => void;
  signal: AbortSignal;
  start: number;
}) {
  // biome-ignore lint/suspicious/noBitwiseOperators: The OS open flags must include O_NOFOLLOW to reject substituted symbolic links.
  const handle = await open(options.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.dev !== options.identity.dev ||
      stats.ino !== options.identity.ino ||
      stats.size < options.minimumSize
    ) {
      await handle.close();
      options.release();
      return null;
    }
  } catch (error) {
    await handle.close();
    options.release();
    throw error;
  }
  let position = options.start;
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    options.signal.removeEventListener("abort", abort);
    options.release();
    await handle.close();
  };
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = () => {
    controller?.error(options.signal.reason);
    void close();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  return new ReadableStream<Uint8Array>({
    async cancel() {
      await close();
    },
    async pull(active) {
      if (position > options.end) {
        await close();
        active.close();
        return;
      }
      const length = Math.min(CHUNK, options.end - position + 1);
      try {
        if (options.beforeRead && !(await options.beforeRead(position, position + length - 1))) {
          await close();
          active.error(new Error("Playback stopped while waiting for verified data"));
          return;
        }
      } catch (error) {
        await close();
        active.error(error);
        return;
      }
      if (closed || options.signal.aborted) {
        return;
      }
      const buffer = new Uint8Array(length);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, length, position));
      } catch (error) {
        await close();
        active.error(error);
        return;
      }
      if (bytesRead === 0) {
        await close();
        active.error(new Error("The file ended before the requested range"));
        return;
      }
      position += bytesRead;
      if (!(closed || options.signal.aborted)) {
        active.enqueue(buffer.subarray(0, bytesRead));
      }
    },
    start(started) {
      controller = started;
      if (options.signal.aborted) {
        abort();
      }
    },
  });
}

/**
 * Serves one torrent file by identity: complete files stream from one descriptor, incomplete
 * ranges wait for verified pieces. Every range is bounded, suffix ranges are honored, and an
 * unsatisfiable range answers 416. `release` is called exactly once when the read ends.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep validation, state changes, and cleanup in the same lifecycle operation.
export async function streamTorrentFile(options: {
  engine: EnginePort;
  /** Extra response headers, such as CORS for external player links. */
  headers: { [name: string]: string };
  id: string;
  index: number;
  range: string | null;
  release: () => void;
  /** Response headers of the route, for the 416 Content-Range. */
  set: Pick<Context["set"], "headers">;
  signal: AbortSignal;
}) {
  const { engine, id, index, release, signal } = options;
  try {
    const detail = await engine.detail(id);
    if (detail instanceof ElysiaStatus) {
      release();
      return detail;
    }
    const file = detail.files[index];
    if (!file) {
      release();
      return problem(404, { detail: "File not found" });
    }
    const size = file.length;
    const complete = file.progress === 1;
    const headers = {
      ...options.headers,
      "accept-ranges": "bytes",
      "content-type": Bun.file(file.name).type,
    };
    if (!options.range && complete) {
      const found = await engine.file(id, index);
      if (found instanceof ElysiaStatus) {
        release();
        return found;
      }
      const { path, identity } = found;
      const body = await openMediaStream({
        end: size - 1,
        identity,
        minimumSize: size,
        path,
        release,
        signal,
        start: 0,
      });
      if (!body) {
        return problem(409, { detail: "The downloaded file changed on the server" });
      }
      return new Response(body, { headers: { ...headers, "content-length": String(size) } });
    }
    const [, first = "", last = ""] = byteRange.exec(options.range ?? "bytes=0-") ?? [];
    // A suffix range ("bytes=-500") requests the last bytes of the file.
    const start = first === "" ? Math.max(size - Number(last), 0) : Number(first);
    const requestedEnd = first === "" || last === "" ? size - 1 : Math.min(Number(last), size - 1);
    if (
      !((first || last) && Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd)) ||
      start > requestedEnd ||
      start >= size
    ) {
      release();
      options.set.headers["content-range"] = `bytes */${size}`;
      return problem(416, { detail: "The requested range is outside the file" });
    }
    // Bound every range so one response cannot hold a whole movie in flight.
    const end = options.range ? Math.min(requestedEnd, start + RANGE_LIMIT - 1) : requestedEnd;
    const initialEnd = options.range ? end : Math.min(end, start + CHUNK - 1);
    let path: string;
    let identity: { dev: number; ino: number };
    if (complete) {
      const found = await engine.file(id, index);
      if (found instanceof ElysiaStatus) {
        release();
        return found;
      }
      ({ path, identity } = found);
    } else {
      const key = crypto.randomUUID();
      // Send the wait first so cancellation cannot overtake its registration in the worker.
      const waiting = engine.waitForRange(key, id, index, start, initialEnd);
      const cancel = async () => {
        try {
          await engine.cancelRange(key);
        } catch (error) {
          const log = createLogger({
            component: "torrent-stream",
            error: sanitizeLog(error),
            operation: "cancel",
          });
          log.setLevel("error");
          log.emit();
        }
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        void cancel();
      }
      try {
        const found = await waiting;
        if (found instanceof ElysiaStatus) {
          release();
          return found;
        }
        ({ path, identity } = found);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
    const body = await openMediaStream({
      beforeRead:
        complete || options.range
          ? undefined
          : async (from, to) => {
              if (to <= initialEnd) {
                return true;
              }
              const key = crypto.randomUUID();
              const waiting = engine.waitForRange(key, id, index, from, to);
              const cancel = async () => {
                await engine.cancelRange(key);
              };
              signal.addEventListener("abort", cancel, { once: true });
              if (signal.aborted) {
                void cancel();
              }
              try {
                const ready = await waiting;
                return (
                  !(ready instanceof ElysiaStatus) &&
                  ready.identity.dev === identity.dev &&
                  ready.identity.ino === identity.ino
                );
              } finally {
                signal.removeEventListener("abort", cancel);
              }
            },
      end,
      identity,
      minimumSize: complete ? size : initialEnd + 1,
      path,
      release,
      signal,
      start,
    });
    if (!body) {
      return problem(409, { detail: "The downloaded file changed on the server" });
    }
    // Keep the read cancellable until its last byte; HEAD supplies the total length to VLC.
    return new Response(body, {
      headers: {
        ...headers,
        "content-length": String(end - start + 1),
        ...(options.range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      },
      status: options.range ? 206 : 200,
    });
  } catch (error) {
    release();
    throw error;
  }
}
