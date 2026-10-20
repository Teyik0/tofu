import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { logEvents } from "./diagnostics";

interface LogOptions {
  dataDir: string;
}

export class ApplicationLogs {
  readonly directory: string;
  private readonly path: string;
  private readonly maxBytes = 5 * 1024 * 1024;
  private bytes = 0;
  private queuedBytes = 0;
  private pending = Promise.resolve();
  private closed = false;
  private readonly listener: (event: Event) => void;

  private constructor(options: LogOptions) {
    this.directory = join(options.dataDir, "logs");
    this.path = join(this.directory, "app.jsonl");
    this.listener = (event) => {
      const { dataDir, line } = (event as CustomEvent<{ dataDir?: string; line: string }>).detail;
      if (dataDir === undefined || dataDir === options.dataDir) {
        this.write(line);
      }
    };
  }

  static async open(options: LogOptions) {
    const logs = new ApplicationLogs(options);
    await mkdir(logs.directory, { mode: 0o700, recursive: true });
    await chmod(logs.directory, 0o700);
    await appendFile(logs.path, "", { mode: 0o600 });
    await chmod(logs.path, 0o600);
    logs.bytes = (await stat(logs.path)).size;
    logEvents.addEventListener("log", logs.listener);
    return logs;
  }

  write(line: string) {
    const bytes = Buffer.byteLength(line);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: close changes the writer state between calls.
    if (this.closed || this.queuedBytes + bytes > 1024 * 1024) {
      return;
    }
    this.queuedBytes += bytes;
    const previous = this.pending;
    // Reserve the write's place in the queue before waiting for earlier writes.
    this.pending = (async () => {
      await previous;
      try {
        if (this.bytes + bytes > this.maxBytes) {
          await this.rotate();
        }
        await appendFile(this.path, line, { mode: 0o600 });
        this.bytes += bytes;
      } catch {
        // A full or disconnected disk must not stop transfers or cause recursive logging.
        process.stderr.write("Tofu could not write its application logs.\n");
      } finally {
        this.queuedBytes -= bytes;
      }
    })();
  }

  /** Shifts archives from oldest to newest and starts an empty log. */
  private async rotate() {
    await rm(`${this.path}.3`, { force: true });
    for (let index = 2; index >= 0; index -= 1) {
      const source = index === 0 ? this.path : `${this.path}.${index}`;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: rotate archives from oldest to newest.
        await rename(source, `${this.path}.${index + 1}`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
    this.bytes = 0;
  }

  async flush() {
    await this.pending;
  }

  async close() {
    logEvents.removeEventListener("log", this.listener);
    this.closed = true;
    await this.pending;
  }
}
