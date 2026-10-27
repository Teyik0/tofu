import "@teyik0/furin/server-only";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { ElysiaStatus, problem } from "elysia";
import type { AccessService, SharingConfig } from "../../modules/access/service";
import { instance } from "../instance";
import { tailscale } from "./index";

const LOCAL_HOST_SUFFIX = /\.local$/i;
const LINK_LOCAL = /^fe[89ab][0-9a-f]:/i;
let advertisement: ReturnType<typeof Bun.spawn<"ignore", "ignore", "ignore">> | null = null;

/**
 * Names and current interface addresses of this server that the installation certificate
 * covers: the `.local` name, extra names and non-loopback, non-link-local addresses. An
 * address the certificate does not cover is never offered to other devices.
 */
export function lanNames(config: SharingConfig) {
  const path = join(instance.dataDir, "tls/server.pem");
  if (!existsSync(path)) {
    return problem(409, { detail: "Create the local network certificate on the server first" });
  }
  const leaf = new X509Certificate(readFileSync(path));
  const now = Date.now();
  if (Date.parse(leaf.validTo) <= now || Date.parse(leaf.validFrom) > now) {
    return problem(409, {
      detail: "The local network certificate is expired or not yet valid. Renew it on the server",
    });
  }
  const names = [
    `${hostname().replace(LOCAL_HOST_SUFFIX, "")}.local`,
    ...config.lan.hostnames,
  ].filter((name) => leaf.checkHost(name) !== undefined);
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(
      (item) =>
        item &&
        !item.internal &&
        !item.address.includes("%") &&
        !LINK_LOCAL.test(item.address) &&
        leaf.checkIP(item.address) !== undefined
    )
    .map((item) => item?.address ?? "");
  const covered = [...new Set([...names, ...addresses])];
  if (covered.length === 0) {
    return problem(409, {
      detail:
        "The local network certificate covers none of this server's current names or addresses. Renew it on the server",
    });
  }
  return covered;
}

/** Opens the local HTTPS ingress and advertises its public port, replacing its previous state. */
export async function openLan(access: AccessService, config: SharingConfig, port: number) {
  const previous = advertisement;
  advertisement = null;
  if (previous && previous.exitCode === null) {
    previous.kill();
    await previous.exited;
  }
  const names = lanNames(config);
  if (names instanceof ElysiaStatus) {
    access.closed("lan", names.response.detail);
    return names;
  }
  const started = await tailscale.start();
  if (started instanceof ElysiaStatus) {
    access.closed("lan", started.response.detail);
    return started;
  }
  const opened = await tailscale.request({
    hosts: names,
    lanPort: config.lan.port,
    method: "lan-open",
    port,
  });
  if (opened instanceof ElysiaStatus) {
    access.closed("lan", opened.response.detail);
    return opened;
  }
  access.opened("lan", opened.hosts ?? []);
  const discovery = process.platform === "darwin" ? Bun.which("dns-sd") : null;
  const identity = access.identity();
  if (process.env.TOFU_DISCOVERY !== "0" && discovery && identity) {
    advertisement = Bun.spawn(
      [
        discovery,
        "-R",
        identity.name,
        "_tofu._tcp",
        "local",
        String(config.lan.port),
        `serverId=${identity.serverId}`,
        "protocol=1",
      ],
      { stderr: "ignore", stdin: "ignore", stdout: "ignore" }
    );
  }
  return opened;
}

/** Closes the local ingress and its advertisement without stopping the private network. */
export async function closeLan(access: AccessService) {
  access.closed("lan");
  const previous = advertisement;
  advertisement = null;
  if (previous && previous.exitCode === null) {
    previous.kill();
    await previous.exited;
  }
  if (!tailscale.running) {
    return;
  }
  return await tailscale.request({ method: "lan-close" });
}
