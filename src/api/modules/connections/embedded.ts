import "@teyik0/furin/server-only";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ElysiaStatus, problem } from "elysia";

export interface EmbeddedStatus {
  approvalUrl?: string;
  authUrl?: string;
  error?: string;
  /** Browser-facing hosts the local network ingress accepts. */
  hosts?: string[];
  httpsEnabled?: boolean;
  origin?: string;
  state: string;
}

/**
 * The single parent-owned native network companion: the embedded tsnet node and the local
 * network HTTPS ingress, which are independent of each other. Inherited stdin/stdout are its
 * only control channel.
 */
export class EmbeddedTailscale {
  private readonly directory: string;
  private readonly certificates: string;
  private child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | null = null;
  private readonly pending = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<EmbeddedStatus>>
  >();
  private startup: Promise<void> | null = null;

  constructor(directory: string, certificates: string) {
    this.directory = directory;
    this.certificates = certificates;
  }

  /** Whether the companion process is running now. */
  running() {
    return this.child !== null;
  }

  available() {
    const extension = process.platform === "win32" ? ".exe" : "";
    return (
      [
        process.env.TOFU_TSNET_BINARY,
        join(dirname(Bun.main), `tofu-tsnet${extension}`),
        join(process.cwd(), "runtime", `tofu-tsnet${extension}`),
      ].find((path) => path && existsSync(path)) ?? null
    );
  }

  private async start() {
    const binary = this.available();
    if (!binary) {
      return;
    }
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    await chmod(this.directory, 0o700);
    const child = Bun.spawn([binary], {
      env: {
        ...process.env,
        TOFU_TLS_STATE_DIR: this.certificates,
        TOFU_TSNET_STATE_DIR: this.directory,
      },
      stderr: "ignore",
      stdin: "pipe",
      stdout: "pipe",
    });
    this.child = child;
    const receive = async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of child.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 65_536) {
            child.kill();
            break;
          }
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const result = JSON.parse(buffer.slice(0, newline)) as EmbeddedStatus & { id: string };
            buffer = buffer.slice(newline + 1);
            this.pending.get(result.id)?.resolve(result);
            this.pending.delete(result.id);
            newline = buffer.indexOf("\n");
          }
        }
      } catch {
        child.kill();
      } finally {
        for (const pending of this.pending.values()) {
          pending.resolve({
            error: "The private network process stopped. Try again",
            state: "stopped",
          });
        }
        this.pending.clear();
        if (this.child === child) {
          this.child = null;
          this.startup = null;
        }
      }
    };
    void receive();
  }

  async request(command: {
    method:
      | "start"
      | "status"
      | "serve"
      | "stop"
      | "logout"
      | "authorize-https"
      | "lan-open"
      | "lan-close";
    hostname?: string;
    hosts?: string[];
    lanPort?: number;
    port?: number;
  }) {
    if (!this.available()) {
      return problem(503, {
        detail: "The native network component is missing. Rebuild or reinstall Tofu",
      });
    }
    // Reserve startup and the response slot before any asynchronous work.
    this.startup ??= this.start();
    const id = crypto.randomUUID();
    const pending = Promise.withResolvers<EmbeddedStatus>();
    this.pending.set(id, pending);
    try {
      await this.startup;
      if (!this.child) {
        return problem(503, { detail: "The private network process could not start" });
      }
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      await this.child.stdin.flush();
      const timeout = setTimeout(
        () =>
          pending.resolve({
            error: "The private network did not answer. Try again",
            state: "stopped",
          }),
        15_000
      );
      try {
        const result = await pending.promise;
        if (result.error) {
          return problem(503, { detail: result.error });
        }
        return result;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return problem(503, { detail: "The private network process stopped. Try again" });
    } finally {
      this.pending.delete(id);
    }
  }

  async [Symbol.asyncDispose]() {
    if (!this.child) {
      return;
    }
    const stopped = await this.request({ method: "stop" });
    if (stopped instanceof ElysiaStatus) {
      this.child?.kill();
    }
    const { child } = this;
    if (child) {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 3000);
      try {
        await child.exited;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}
