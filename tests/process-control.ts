// Test subprocesses opt in through --preload. Packaged applications never load this helper.
process.on("message", (message: unknown) => {
  if (message === "shutdown") {
    process.emit("SIGTERM");
  }
});
