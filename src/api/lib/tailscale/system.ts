import "@teyik0/furin/server-only";
import { existsSync } from "node:fs";
import { Effect, Result } from "effect";

const DNS_TRAILING_DOT = /\.$/;

/** Observable Tailscale prerequisites, in the order the user resolves them. */
export type TailscaleState =
  | { state: "not-installed" }
  | { state: "signed-out" }
  | { state: "https-disabled"; hostname: string }
  | { state: "conflict"; origin: string; detail: string }
  | { state: "available"; origin: string }
  | { state: "ready"; origin: string };

const MAC_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** The Tailscale CLI, overridable for tests and unusual installations. */
function executable() {
  if (process.env.TOFU_TAILSCALE_CLI) {
    return existsSync(process.env.TOFU_TAILSCALE_CLI) ? process.env.TOFU_TAILSCALE_CLI : null;
  }
  const found = Bun.which("tailscale");
  if (found) {
    return found;
  }
  return process.platform === "darwin" && existsSync(MAC_CLI) ? MAC_CLI : null;
}

async function run(args: string[]) {
  const cli = executable();
  if (!cli) {
    return null;
  }
  const child = Bun.spawn([cli, ...args], { stderr: "pipe", stdout: "pipe", timeout: 10_000 });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stderr, stdout };
}

interface ServeConfig {
  AllowFunnel?: { [hostPort: string]: boolean };
  TCP?: { [port: string]: { HTTPS?: boolean } };
  Web?: { [hostPort: string]: { Handlers?: { [path: string]: { Proxy?: string } } } };
}

/**
 * Reads Tailscale status and the HTTPS 443 Serve mapping. Tofu owns only the exact mapping
 * `https://<this machine>:443/ → http://127.0.0.1:<port>`; anything else on 443 is a conflict
 * that Tofu reports and never changes.
 */
export async function checkTailscale(port: number): Promise<TailscaleState> {
  const status = await run(["status", "--json"]);
  if (!status) {
    return { state: "not-installed" };
  }
  const parsedResult = Effect.runSync(
    Effect.result(
      Effect.try(
        () =>
          JSON.parse(status.stdout) as {
            BackendState?: string;
            CertDomains?: string[];
            Self?: { DNSName?: string };
          }
      )
    )
  );
  if (Result.isFailure(parsedResult)) {
    return { state: "signed-out" };
  }
  const parsed = parsedResult.success;
  if (parsed.BackendState !== "Running" || !parsed.Self?.DNSName) {
    return { state: "signed-out" };
  }
  const hostname = parsed.Self.DNSName.replace(DNS_TRAILING_DOT, "");
  if (!parsed.CertDomains?.includes(hostname)) {
    return { hostname, state: "https-disabled" };
  }
  const origin = `https://${hostname}`;
  const serve = await run(["serve", "status", "--json"]);
  const configResult = Effect.runSync(
    Effect.result(
      Effect.try(() => (serve?.stdout.trim() ? JSON.parse(serve.stdout) : {}) as ServeConfig)
    )
  );
  if (Result.isFailure(configResult)) {
    return {
      detail: "Tailscale Serve returned an unreadable configuration",
      origin,
      state: "conflict",
    };
  }
  const config = configResult.success;
  const site = config.Web?.[`${hostname}:443`];
  if (config.AllowFunnel?.[`${hostname}:443`]) {
    return {
      detail: "Funnel exposes this address to the public internet. Turn it off in Tailscale first",
      origin,
      state: "conflict",
    };
  }
  if (!(site || config.TCP?.["443"])) {
    return { origin, state: "available" };
  }
  const handlers = Object.entries(site?.Handlers ?? {});
  if (
    handlers.length === 1 &&
    handlers[0]?.[0] === "/" &&
    handlers[0][1].Proxy === `http://127.0.0.1:${port}`
  ) {
    return { origin, state: "ready" };
  }
  return {
    detail: "Another service already uses HTTPS on this machine's Tailscale address",
    origin,
    state: "conflict",
  };
}

/** Creates Tofu's mapping only when 443 is free; never touches Funnel or other mappings. */
export async function enableTailscale(port: number) {
  const current = await checkTailscale(port);
  if (current.state !== "available") {
    return { ...current, created: false };
  }
  const result = await run(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
  if (result?.code !== 0) {
    return {
      detail: result?.stderr.trim() || "Tailscale Serve could not be configured",
      origin: current.origin,
      state: "conflict" as const,
    };
  }
  return { ...(await checkTailscale(port)), created: true };
}

/** Removes the mapping only if it is still exactly the one Tofu created. */
export async function disableTailscale(port: number) {
  const current = await checkTailscale(port);
  if (current.state !== "ready") {
    return current;
  }
  await run(["serve", "--https=443", "off"]);
  return await checkTailscale(port);
}
