import { version } from "../../../package.json";

export interface LogInput {
  component: string;
  context?: Record<string, unknown>;
  dataDir?: string;
  error?: unknown;
  level: "info" | "warn" | "error";
  operation: string;
}

export const logEvents = new EventTarget();
const sensitiveKey =
  /authorization|cookie|password|secret|token|api[-_]?key|credential|headers|body|metadata|source/i;
const sensitiveValue =
  /((?:authorization|cookie|password|secret|token|api[-_]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const bearer = /\bBearer\s+[^\s,;]+/gi;
const sensitiveHeader = /\b(authorization|(?:set-)?cookie)\s*:\s*[^\r\n]*/gi;
const urlCredentials = /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi;
const urlQuery = /([?&](?:[^\s=&#]*(?:token|key|secret|password|cookie)[^\s=&#]*)=)[^\s&#]*/gi;

const mediaLinkPath = /\/media\/x\/[^/\s?#]+/g;
const invitationFragment = /([#&]i=)[A-Za-z0-9_-]+/g;

export function sanitizeLog(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return value
      .replace(sensitiveHeader, "$1: [redacted]")
      .replace(bearer, "Bearer [redacted]")
      .replace(urlCredentials, "$1[redacted]@")
      .replace(urlQuery, "$1[redacted]")
      .replace(mediaLinkPath, "/media/x/[redacted]")
      .replace(invitationFragment, "$1[redacted]")
      .replace(sensitiveValue, "$1[redacted]")
      .slice(0, 8192);
  }
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? String(value) : value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  try {
    if (value instanceof Error) {
      const fields: Record<string, unknown> = {
        cause: value.cause,
        message: value.message,
        name: value.name,
        stack: value.stack,
      };
      if (value instanceof AggregateError) {
        fields.errors = value.errors;
      }
      for (const key of ["code", "syscall", "path", "expected", "observed"]) {
        if (key in value) {
          fields[key] = Reflect.get(value, key);
        }
      }
      return sanitizeLog(fields, seen, depth + 1);
    }
    if (Array.isArray(value)) {
      return value.slice(0, 32).map((item) => sanitizeLog(item, seen, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([key, item]) => [
          key,
          sensitiveKey.test(key) ? "[redacted]" : sanitizeLog(item, seen, depth + 1),
        ])
    );
  } finally {
    seen.delete(value);
  }
}

export function recordLog(input: LogInput) {
  const { dataDir, ...fields } = input;
  const record = {
    ...fields,
    pid: process.pid,
    timestamp: new Date().toISOString(),
    version,
  };
  let line = JSON.stringify(sanitizeLog(record));
  if (Buffer.byteLength(line) > 64 * 1024) {
    line = JSON.stringify(
      sanitizeLog({
        ...record,
        context: { truncated: true },
        error:
          input.error instanceof Error
            ? { message: input.error.message, name: input.error.name, stack: input.error.stack }
            : "Error details exceeded the log size limit",
      })
    );
  }
  logEvents.dispatchEvent(new CustomEvent("log", { detail: { dataDir, line: `${line}\n` } }));
}
