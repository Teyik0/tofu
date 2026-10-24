import { type DrainContext, defineEvlog } from "evlog";
import { createFsDrain } from "evlog/fs";
import { createDrainPipeline } from "evlog/pipeline";
import { version } from "./package.json";
import { instance } from "./src/api/lib/instance";

const fileDrain = createFsDrain({
  dir: instance.logDirectory,
  maxFiles: 4,
  maxSizePerFile: 5 * 1024 * 1024,
  pretty: true,
});

const pipeline = createDrainPipeline<DrainContext>({
  batch: { intervalMs: 1000, size: 25 },
  maxBufferSize: 1000,
  onDropped(events) {
    process.stderr.write(`Tofu dropped ${events.length} application log events.\n`);
  },
  retry: { initialDelayMs: 250, maxAttempts: 3, maxDelayMs: 1000 },
});


export const config = defineEvlog({
  drain: pipeline(async (batch) => await fileDrain.raw(batch)),
  env: { version },
  include: ["/api/**"],
  redact: {
    paths: [
      "**.authorization",
      "**.cookie",
      "**.headers",
      "**.body",
      "**.metadata",
      "**.source",
      "**.*apiKey",
      "**.*api_key",
      "**.*api-key",
      "**.*credential*",
    ],
    patterns: [
      /\/media\/x\/[^/\s?#]+/g,
      /[#&](?:i|transfer|reconnect)=[A-Za-z0-9_-]+/g,
      /https?:\/\/[^\s/@]+:[^\s/@]+@/gi,
      /[?&][^\s=&#]*(?:token|key|secret|password|cookie)[^\s=&#]*=[^\s&#]*/gi,
      /\b(?:authorization|(?:set-)?cookie)\s*:\s*[^\r\n]*/gi,
      /(?:password|secret|token|api[-_]?key)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    ],
    transform(event) {
      event.pid = process.pid;
      if (Buffer.byteLength(JSON.stringify(event)) > 64 * 1024) {
        event.context = { truncated: true };
        event.error = { message: "Error details exceeded the log size limit" };
      }
    },
  },
  service: "tofu",
  silent: instance.profile === "release",
});
