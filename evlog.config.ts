import { defineEvlog } from "evlog";
import { version } from "./package.json";
import { sanitizeLog } from "./src/api/lib/diagnostics";
import { logDrain } from "./src/api/lib/logs";

export const config = defineEvlog({
  drain: logDrain,
  env: { version },
  include: ["/api/**"],
  redact: {
    builtins: false,
    transform(event) {
      event.pid = process.pid;
      if (
        event.error &&
        typeof event.error === "object" &&
        "name" in event.error &&
        event.error.name === "ValidationError"
      ) {
        event.error = { message: "Request validation failed", name: "ValidationError" };
      }
      const sanitized = sanitizeLog(event);
      if (sanitized && typeof sanitized === "object") {
        Object.assign(event, sanitized);
      }
      if (Buffer.byteLength(JSON.stringify(event)) > 64 * 1024) {
        event.context = { truncated: true };
        event.error = { message: "Error details exceeded the log size limit" };
      }
    },
  },
  service: "tofu",
  silent: true,
});
