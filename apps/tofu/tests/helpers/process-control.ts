import { existsSync, writeFileSync } from "node:fs";

const identityPath = process.env.TOFU_TEST_PID;
if (identityPath) {
  try {
    writeFileSync(identityPath, String(process.pid), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

process.send?.(process.pid);

// Watch-mode restarts do not reliably preserve the parent's IPC channel on Windows.
// Test subprocesses opt in through --preload; packaged applications never load this helper.
const shutdownPath = process.env.TOFU_TEST_SHUTDOWN;
if (shutdownPath) {
  const timer = setInterval(() => {
    if (existsSync(shutdownPath) && process.listenerCount("SIGTERM") > 0) {
      clearInterval(timer);
      process.emit("SIGTERM");
    }
  }, 100);
  timer.unref();
}
