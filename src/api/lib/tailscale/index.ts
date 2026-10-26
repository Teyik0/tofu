import "@teyik0/furin/server-only";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Result } from "effect";
import { problem } from "elysia";
import { instance } from "../instance";
import type { TailscaleCommand, TailscaleStatus } from "./model";

type Companion = ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;

const extension = process.platform === "win32" ? ".exe" : "";
const directory = join(instance.dataDir, "tailscale");
const certificates = join(instance.dataDir, "tls");
const binary = [
  process.env.TOFU_TSNET_BINARY,
  join(dirname(Bun.main), `tofu-tsnet${extension}`),
  join(process.cwd(), "runtime", `tofu-tsnet${extension}`),
].find((path) => path && existsSync(path));

const pending = new Map<string, ReturnType<typeof Promise.withResolvers<TailscaleStatus>>>();
let child: Companion | null = null;
let starting: Promise<void> | null = null;
let reading: Promise<void> | null = null;
let closing: Promise<void> | null = null;

async function receive(companion: Companion) {
  const decoder = new TextDecoder();
  let buffer = "";

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => {
    for (const response of pending.values()) {
      response.resolve({ error: "The network companion stopped", state: "stopped" });
    }
    pending.clear();
    if (child === companion) {
      child = null;
    }
  });
  const received = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise(async () => {
        for await (const chunk of companion.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 65_536) {
            companion.kill();
            break;
          }
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const response = JSON.parse(buffer.slice(0, newline)) as TailscaleStatus & {
              id: string;
            };
            buffer = buffer.slice(newline + 1);
            pending.get(response.id)?.resolve(response);
            pending.delete(response.id);
            newline = buffer.indexOf("\n");
          }
        }
      })
    )
  );
  if (Result.isFailure(received)) {
    // A failed native transport must terminate and settle every pending request.
    companion.kill();
  }
}

export const tailscale = {
  binary,

  async close() {
    if (closing) {
      await closing;
      return;
    }
    const stopped = Promise.withResolvers<void>();
    closing = stopped.promise;
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(stopped.resolve);
    await starting;
    const companion = child;
    if (!companion) {
      return;
    }
    cleanup.defer(async () => {
      if (companion.exitCode === null) {
        companion.kill();
      }
      await companion.exited;
      await reading;
    });
    const timeout = setTimeout(() => companion.kill(), 3000);
    cleanup.defer(() => clearTimeout(timeout));
    // EOF makes the native companion close both LAN and Tailscale listeners.
    companion.stdin.end();
    await companion.exited;
  },

  async request(command: TailscaleCommand) {
    const companion = child;
    if (!companion || closing) {
      return problem(503, { detail: "The network companion is not running" });
    }
    const id = crypto.randomUUID();
    const response = Promise.withResolvers<TailscaleStatus>();
    pending.set(id, response);
    using cleanup = new DisposableStack();
    cleanup.defer(() => pending.delete(id));
    const timeout = setTimeout(() => {
      response.resolve({ error: "The network companion did not answer", state: "timeout" });
    }, 15_000);
    cleanup.defer(() => clearTimeout(timeout));

    const sent = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise(async () => {
          companion.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
          await companion.stdin.flush();
        })
      )
    );
    if (Result.isFailure(sent)) {
      return problem(503, {
        detail: "The command could not be sent to the network companion",
      });
    }
    const result = await response.promise;
    if (result.error) {
      return problem(503, { detail: result.error });
    }
    return result;
  },

  get running() {
    return child !== null;
  },

  async start() {
    if (closing) {
      return problem(503, { detail: "The network companion is shutting down" });
    }
    if (starting) {
      await starting;
      if (!child) {
        return problem(503, { detail: "The network companion could not start" });
      }
      return;
    }
    if (child) {
      return;
    }
    if (!binary) {
      return problem(503, {
        detail: "The native network component is missing. Rebuild or reinstall Tofu",
      });
    }

    const startup = Promise.withResolvers<void>();
    starting = startup.promise;
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      starting = null;
      startup.resolve();
    });

    const started = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise(async () => {
          await mkdir(directory, { mode: 0o700, recursive: true });
          await chmod(directory, 0o700);
          const companion = Bun.spawn([binary], {
            env: {
              ...process.env,
              TOFU_TLS_STATE_DIR: certificates,
              TOFU_TSNET_STATE_DIR: directory,
            },
            stderr: "ignore",
            stdin: "pipe",
            stdout: "pipe",
          });
          child = companion;
          reading = receive(companion);
        })
      )
    );
    if (Result.isFailure(started)) {
      // Translate filesystem and process creation failures at the I/O boundary.
      return problem(503, { detail: "The network companion could not start" });
    }
  },
};
