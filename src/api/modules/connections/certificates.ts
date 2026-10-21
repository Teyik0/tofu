import "@teyik0/furin/server-only";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { problem } from "elysia";
import { instance } from "../../lib/database-plugin";
import type { EmbeddedTailscale } from "./embedded";

const LOCAL_HOST_SUFFIX = /\.local$/i;

const directory = join(instance.dataDir, "tls");

/**
 * The local network certificate. Only connecting devices need to trust its installation CA: the
 * native companion terminates HTTPS and the host's own window stays on loopback HTTP.
 */
export function localCertificate() {
  const path = join(directory, "server.pem");
  if (!existsSync(path)) {
    return null;
  }
  const leaf = new X509Certificate(readFileSync(path));
  const ca = new X509Certificate(readFileSync(join(directory, "ca.pem")));
  return {
    expiresAt: Date.parse(leaf.validTo),
    fingerprint: ca.fingerprint256,
    names: leaf.subjectAltName,
  };
}

export async function prepareCertificate(embeddedTailscale: EmbeddedTailscale, names: string[]) {
  const binary = embeddedTailscale.available();
  if (!binary) {
    return problem(503, {
      detail: "The native certificate component is missing. Rebuild or reinstall Tofu",
    });
  }
  const addresses = Object.values(networkInterfaces()).flatMap(
    (entries) =>
      entries
        ?.filter((entry) => !(entry.internal || entry.address.includes("%")))
        .map((entry) => entry.address) ?? []
  );
  const child = Bun.spawn([binary, "certificates"], {
    env: { ...process.env, TOFU_TLS_STATE_DIR: directory },
    stderr: "ignore",
    stdin: "pipe",
    stdout: "pipe",
    timeout: 15_000,
  });
  child.stdin.write(
    JSON.stringify({
      names: [...names, `${hostname().replace(LOCAL_HOST_SUFFIX, "")}.local`, ...addresses],
    })
  );
  child.stdin.end();
  const [code] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) {
    return problem(503, { detail: "The local network certificate could not be created" });
  }
  return localCertificate();
}
