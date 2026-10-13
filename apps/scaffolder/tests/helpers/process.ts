export async function runBun(args: string[], cwd: string | undefined) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stderr, stdout };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}
