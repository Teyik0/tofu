import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { DrainContext } from "evlog";
import { createFsDrain } from "evlog/fs";
import { createDrainPipeline } from "evlog/pipeline";
import { instance } from "./instance";

export const logDirectory = join(instance.dataDir, "logs");
const logFiles = new Bun.Glob("*.jsonl");

const fileDrain = createFsDrain({
  dir: logDirectory,
  maxFiles: 4,
  maxSizePerFile: 5 * 1024 * 1024,
  pretty: false,
});

const pipeline = createDrainPipeline<DrainContext>({
  batch: { intervalMs: 1000, size: 25 },
  maxBufferSize: 1000,
  onDropped(events) {
    process.stderr.write(`Tofu dropped ${events.length} application log events.\n`);
  },
  retry: { initialDelayMs: 250, maxAttempts: 3, maxDelayMs: 1000 },
});

export const logDrain = pipeline(async (batch) => {
  await fileDrain.raw(batch);
  const files = await Array.fromAsync(
    logFiles.scan({ absolute: true, cwd: logDirectory, dot: true })
  );
  await Promise.all(files.map((file) => chmod(file, 0o600)));
});
