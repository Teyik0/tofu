import { constants, existsSync, readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { nativeControl } from "../../../native/control";
import { sync } from "../../../sync";
import { instance } from "../../lib/database-plugin";
import { runtime } from "../../lib/runtime";
import { cookieName } from "../access/admission";
import { accessPlugin } from "../access/plugin";
import { localCertificate, prepareCertificate } from "./certificates";
import { connectionsUpdateSchema } from "./model";
import { connectionsServicePlugin } from "./plugin";
import { checkTailscale } from "./tailscale";
import { updateRemoteAccess } from "./update";

export const connectionsPlugin = new Elysia({ name: "tofu-connections-api" })
  .use(connectionsServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ administration: true, idempotent: false })
  .get("/connections", ({ access, connections, embeddedTailscale }) => {
    const identity = access.identity();
    return {
      /** Local network HTTPS origins the ingress serves now; each is covered by the certificate. */
      addresses: connections.lanOrigins(),
      config: connections.config(),
      enabled: connections.policy().enabled,
      exposures: connections.exposures(embeddedTailscale.running()),
      listening: connections.listening(),
      server: { id: identity.serverId, name: identity.name },
    };
  })
  .get("/connections/certificate", { owner: true }, () => ({
    certificate: localCertificate(),
  }))
  .post("/connections/certificate", { owner: true }, async ({ connections, embeddedTailscale }) => {
    const turn = connections.reserve();
    try {
      await turn.previous;
      const config = connections.config();
      if (config.lan.enabled) {
        return problem(409, {
          detail: "Turn off local network sharing before renewing its certificate",
        });
      }
      return await prepareCertificate(embeddedTailscale, config.lan.hostnames);
    } finally {
      turn.release();
    }
  })
  .get("/connections/certificate/download", { owner: true }, ({ set }) => {
    if (!localCertificate()) {
      return problem(404, { detail: "Create the local network certificate first" });
    }
    set.headers["cache-control"] = "private, no-store";
    set.headers["content-disposition"] = 'attachment; filename="Tofu-CA.pem"';
    set.headers["content-type"] = "application/x-pem-file";
    return readFileSync(join(instance.dataDir, "tls/ca.pem"), "utf8");
  })
  .post("/connections/certificate/download", { owner: true }, async () => {
    const sdk = nativeControl.tofuNativeSdk;
    if (runtime.current.kind !== "desktop" || !sdk) {
      return problem(409, { detail: "Use the browser download to save the installation CA" });
    }
    if (!localCertificate()) {
      return problem(404, { detail: "Create the local network certificate first" });
    }
    const [folder] = await sdk.Utils.openFileDialog({
      allowsMultipleSelection: false,
      canChooseDirectory: true,
      canChooseFiles: false,
      startingFolder: join(homedir(), "Downloads"),
    });
    if (!folder) {
      return { path: null };
    }
    const path = join(folder, "Tofu-CA.pem");
    try {
      if (existsSync(path)) {
        // Repeated exports of this installation's public CA reuse the existing file.
        if (!readFileSync(path).equals(readFileSync(join(instance.dataDir, "tls/ca.pem")))) {
          return problem(409, {
            detail: "A different Tofu-CA.pem already exists in this folder. Choose another folder",
          });
        }
      } else {
        await copyFile(join(instance.dataDir, "tls/ca.pem"), path, constants.COPYFILE_EXCL);
      }
    } catch {
      return problem(503, { detail: "The installation CA could not be saved in this folder" });
    }
    sdk.Utils.showItemInFolder(path);
    return { path };
  })
  .post("/connections/tailscale/enroll", { owner: true }, async ({ access, embeddedTailscale }) => {
    const status = await embeddedTailscale.request({
      hostname: `tofu-${access.identity().serverId.slice(0, 8)}`,
      method: "start",
    });
    return status;
  })
  .post(
    "/connections/tailscale/logout",
    { owner: true },
    async ({ connections, embeddedTailscale }) => {
      const turn = connections.reserve();
      try {
        await turn.previous;
        const { tailscale } = connections.config();
        if (tailscale.enabled && tailscale.mode === "embedded") {
          return problem(409, {
            detail: "Turn off Tailscale sharing before signing out of Tailscale",
          });
        }
        return await embeddedTailscale.request({ method: "logout" });
      } finally {
        turn.release();
      }
    }
  )
  .post("/connections/tailscale/https", { owner: true }, ({ embeddedTailscale }) =>
    embeddedTailscale.request({ method: "authorize-https" })
  )
  .get("/connections/tailscale/embedded", { owner: true }, ({ embeddedTailscale }) =>
    embeddedTailscale.request({ method: "status" })
  )
  .post("/connections/tailscale/check", async ({ connections }) => {
    const turn = connections.reserve();
    try {
      await turn.previous;
      const config = connections.config();
      const status = await checkTailscale(connections.servicePort());
      if (status.state === "ready" && config.tailscale.origin !== status.origin) {
        connections.save({ ...config, tailscale: { ...config.tailscale, origin: status.origin } });
      }
      return status;
    } finally {
      turn.release();
    }
  })
  .put(
    "/connections",
    { body: connectionsUpdateSchema },
    async ({ access, body, caller, connections, cookie, embeddedTailscale }) => {
      const updated = await updateRemoteAccess(
        connections,
        embeddedTailscale,
        body,
        caller.kind === "owner"
      );
      if (updated instanceof ElysiaStatus) {
        return updated;
      }
      const { config, previous } = updated;
      // Streams opened through an exposure that was turned off end; devices reconnect through
      // the exposures that remain.
      if (!config[body.transport].enabled && previous[body.transport].enabled) {
        access.disconnectRemoteReaders();
      }
      const shared = config.lan.enabled || config.proxy.enabled || config.tailscale.enabled;
      const wasShared =
        previous.lan.enabled || previous.proxy.enabled || previous.tailscale.enabled;
      // A headless owner on loopback loses implicit access once others may connect; keep this
      // browser signed in as an administrator device instead of locking it out.
      if (caller.kind === "owner" && runtime.current.kind === "server" && shared && !wasShared) {
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
      return { config };
    }
  );
