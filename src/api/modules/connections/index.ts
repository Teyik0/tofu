import { readFileSync } from "node:fs";
import { join } from "node:path";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { sync } from "../../../sync";
import { instance } from "../../lib/database-plugin";
import { runtime } from "../../lib/runtime";
import { cookieName } from "../access/admission";
import { accessPlugin } from "../access/plugin";
import { hostTrust, localCertificate, prepareCertificate } from "./certificates";
import { connectionsUpdateSchema } from "./model";
import { connections, embeddedTailscale } from "./plugin";
import { checkTailscale } from "./tailscale";
import { updateRemoteAccess } from "./update";

export const connectionsPlugin = new Elysia({ name: "tofu-connections-api" })
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ administration: true, idempotent: false })
  .get("/connections", ({ access }) => {
    const config = connections.config();
    const identity = access.identity();
    return {
      addresses: config.enabled && config.transport === "lan" ? connections.lanOrigins(config) : [],
      config,
      listening: connections.listening(),
      server: { id: identity.serverId, name: identity.name },
    };
  })
  .get("/connections/certificate", { owner: true }, async () => ({
    certificate: localCertificate(),
    trust: await hostTrust(),
  }))
  .post("/connections/certificate", { owner: true }, () => {
    const config = connections.config();
    if (config.enabled && config.transport === "lan") {
      return problem(409, {
        detail: "Turn off local network sharing before renewing its certificate",
      });
    }
    return prepareCertificate(config.lanHostnames);
  })
  .get("/connections/certificate/download", { owner: true }, () => {
    if (!localCertificate()) {
      return problem(404, { detail: "Create the local network certificate first" });
    }
    return new Response(readFileSync(join(instance.dataDir, "tls/ca.pem")), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": 'attachment; filename="Tofu-CA.pem"',
        "content-type": "application/x-pem-file",
      },
    });
  })
  .post("/connections/tailscale/enroll", { owner: true }, async ({ access }) => {
    const status = await embeddedTailscale.request({
      hostname: `tofu-${access.identity().serverId.slice(0, 8)}`,
      method: "start",
    });
    return status;
  })
  .post("/connections/tailscale/logout", { owner: true }, async () => {
    if (connections.config().enabled && connections.config().transport === "tailscale") {
      return problem(409, { detail: "Turn off remote access before signing out of Tailscale" });
    }
    return await embeddedTailscale.request({ method: "logout" });
  })
  .post("/connections/tailscale/https", { owner: true }, () =>
    embeddedTailscale.request({ method: "authorize-https" })
  )
  .get("/connections/tailscale/embedded", { owner: true }, () =>
    embeddedTailscale.request({ method: "status" })
  )
  .post("/connections/tailscale/check", async () => {
    const config = connections.config();
    const status = await checkTailscale(connections.servicePort(config));
    if (status.state === "ready" && config.tailscaleOrigin !== status.origin) {
      connections.save({ ...config, tailscaleOrigin: status.origin });
    }
    return status;
  })
  .put(
    "/connections",
    { body: connectionsUpdateSchema },
    async ({ access, body, caller, cookie }) => {
      const updated = await updateRemoteAccess(body, caller.kind === "owner");
      if (updated instanceof ElysiaStatus) {
        return updated;
      }
      const { applied, previous } = updated;
      if (!applied.config.enabled) {
        access.disconnectRemoteReaders();
      }
      // A headless owner on loopback loses implicit access once others may connect; keep this
      // browser signed in as an administrator device instead of locking it out.
      if (
        caller.kind === "owner" &&
        runtime.current.kind === "server" &&
        applied.config.enabled &&
        !previous.enabled
      ) {
        const device = access.adoptOwnerBrowser();
        const secure = caller.origin.startsWith("https:");
        cookie[cookieName(access.identity().serverId, secure)]?.set({
          httpOnly: true,
          maxAge: 365 * 86_400,
          path: "/",
          sameSite: "strict",
          secure,
          value: device.token,
        });
      }
      return applied;
    }
  )
  // Sent through the new address within 90 seconds; otherwise the previous configuration returns.
  .post("/connections/confirm", () => connections.confirm());
