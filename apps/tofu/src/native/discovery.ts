// DNS-SD supplies untrusted address hints. Pairing still validates TLS and public server identity.
const SERVICE_NAME = /\s+Add\s+.*?\s+_tofu\._tcp\.\s+(.+)$/;
const SERVICE_ADDRESS = /can be reached at ([A-Za-z0-9._-]+):(\d+)/;
const TRAILING_DOT = /\.$/;

async function discoveryOutput(executable: string, args: string[]) {
  const child = Bun.spawn([executable, ...args], { stderr: "ignore", stdout: "pipe" });
  const timeout = setTimeout(() => child.kill(), 2000);
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Bound output from one supervised DNS-SD process.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.length;
      if (length > 65_536) {
        child.kill();
        break;
      }
      chunks.push(value);
    }
    await child.exited;
    const bytes = new Uint8Array(
      length > 65_536 ? chunks.reduce((total, chunk) => total + chunk.length, 0) : length
    );
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    reader.releaseLock();
  }
}

/** Best-effort Bonjour discovery on macOS; all platforms retain manual HTTPS entry. */
export async function discoverLocalServers() {
  const executable = process.env.TOFU_DISCOVERY_CLI ?? Bun.which("dns-sd");
  if (process.platform !== "darwin" || !executable) {
    return {
      detail:
        "Local discovery is unavailable on this platform. Enter the server's HTTPS address and invitation instead.",
      servers: [] as { name: string; address: string }[],
    };
  }
  const browse = await discoveryOutput(executable, ["-B", "_tofu._tcp", "local"]);
  const names = [
    ...new Set(
      browse.split("\n").flatMap((line) => {
        const name = line.match(SERVICE_NAME)?.[1]?.trim();
        return name ? [name] : [];
      })
    ),
  ].slice(0, 8);
  const found = await Promise.all(
    names.map(async (name) => {
      const output = await discoveryOutput(executable, ["-L", name, "_tofu._tcp", "local"]);
      const match = output.match(SERVICE_ADDRESS);
      const hostname = match?.[1]?.replace(TRAILING_DOT, "");
      const port = Number(match?.[2]);
      if (!(hostname?.endsWith(".local") && Number.isInteger(port)) || port < 1 || port > 65_535) {
        return null;
      }
      return { address: `https://${hostname}:${port}`, name };
    })
  );
  const servers = found.filter((item) => item !== null);
  return {
    detail: servers.length
      ? "Found on this network. Verify the address and use an invitation; discovery does not grant access."
      : "No Tofu server responded on this network. Enter an HTTPS address instead.",
    servers,
  };
}
