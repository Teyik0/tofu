import { type DrainContext, initLogger } from "evlog";
import { readFsLogs } from "evlog/fs";
import type { PipelineDrainFn } from "evlog/pipeline";
import { loggerConfig } from "../../src/api/lib/diagnostics";

export const testLogDrains = new Map<string, PipelineDrainFn<DrainContext>>();

initLogger({
  ...loggerConfig,
  drain(context) {
    const { dataDir } = context.event;
    if (typeof dataDir === "string") {
      testLogDrains.get(dataDir)?.(context);
    }
  },
});

export async function readLogRecords(directory: string) {
  const records: Record<string, unknown>[] = [];
  for await (const event of readFsLogs({ dir: directory })) {
    records.push(event);
  }
  return records;
}
