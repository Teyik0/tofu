import { chmod } from "node:fs/promises";
import { join } from "node:path";

/** A fake Tailscale CLI at its command-line boundary; it records every invocation. */
export async function fakeTailscale(directory: string, serve: object) {
  const state = join(directory, "tailscale-state.json");
  const cli = join(directory, "tailscale");
  await Bun.write(state, JSON.stringify({ calls: [], serve }));
  await Bun.write(
    cli,
    `#!/usr/bin/env bun
const path = ${JSON.stringify(state)};
const state = await Bun.file(path).json();
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
if (args[0] === "status") {
  console.log(JSON.stringify({ BackendState: "Running", CertDomains: ["home.tail-test.ts.net"], Self: { DNSName: "home.tail-test.ts.net." } }));
} else if (args[0] === "serve" && args[1] === "status") {
  console.log(JSON.stringify(state.serve));
} else if (args[0] === "serve" && args.includes("off")) {
  state.serve = {};
} else if (args[0] === "serve" && args[1] === "--bg") {
  state.serve = { TCP: { 443: { HTTPS: true } }, Web: { "home.tail-test.ts.net:443": { Handlers: { "/": { Proxy: args[3] } } } } };
}
await Bun.write(path, JSON.stringify(state));
`
  );
  await chmod(cli, 0o755);
  return {
    cli,
    async configure(configuration: object) {
      const current = await Bun.file(state).json();
      await Bun.write(state, JSON.stringify({ ...current, serve: configuration }));
    },
    read: async () => (await Bun.file(state).json()) as { calls: string[]; serve: object },
  };
}
