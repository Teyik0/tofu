import { constants, existsSync, readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { createLogger } from "evlog";
import { nativeControl } from "../../../native/control";
import { sync } from "../../../sync";
import { instance } from "../../lib/instance";
import { runtime } from "../../lib/runtime";
import { tailscale } from "../../lib/tailscale";
import { localCertificate, prepareCertificate } from "../../lib/tailscale/certificates";
import { checkTailscale } from "../../lib/tailscale/system";
import { cookieName } from "./admission";
import {
  connectionsUpdateSchema,
  deviceChangeSchema,
  invitationSchema,
  pairSchema,
  reconnectionClaimSchema,
  reconnectionCompleteSchema,
  reconnectionDecisionSchema,
  reconnectionSchema,
  serverNameSchema,
  sessionTransferSchema,
} from "./model";
import { accessPlugin } from "./plugin";
import { updateRemoteAccess } from "./sharing";

const SESSION_COOKIE_MAX_AGE = 365 * 86_400;

export const accessRoutesPlugin = new Elysia({ name: "tofu-access-api" })
  .use(accessPlugin)
  .use(furinSync(sync))
  .get("/session", { personal: true }, ({ access, caller, set }) => {
    set.headers["cache-control"] = "private, no-store";
    return access.sessionView(caller, {
      native: runtime.current.kind === "desktop",
      remoteAccess: access.policy().enabled,
    });
  })
  .post(
    "/auth/pair",
    { body: pairSchema, idempotent: false, public: true },
    ({ access, body, caller, cookie, devices, invitations, request, set }) => {
      set.headers["cache-control"] = "no-store";
      // A browser page never receives a durable desktop or server credential.
      if (body.kind !== "browser" && request.headers.has("origin")) {
        return problem(403, { detail: "Open this invitation in the Tofu desktop app" });
      }
      if (body.preview) {
        return invitations.preview(body);
      }
      const paired = invitations.redeem(body);
      if (paired instanceof ElysiaStatus) {
        return paired;
      }
      const identity = access.identity();
      const result = {
        device: devices.summary(paired.device),
        server: { id: identity.serverId, name: identity.name },
      };
      if (body.kind !== "browser") {
        return { ...result, token: paired.session.token };
      }
      const origin = caller.kind === "in-process" ? new URL(request.url).origin : caller.origin;
      const secure = origin.startsWith("https:");
      cookie[cookieName(identity.serverId, secure)]?.set({
        httpOnly: true,
        maxAge: SESSION_COOKIE_MAX_AGE,
        path: "/",
        sameSite: "strict",
        secure,
        value: paired.session.token,
      });
      const log = createLogger({
        component: "access",
        context: { deviceId: paired.device.id, origin, secure },
        operation: "browser-paired",
      });
      log.emit();
      return { ...result, token: null };
    }
  )
  .post(
    "/auth/session-transfers",
    { idempotent: false, personal: true },
    ({ access, caller, set }) => {
      set.headers["cache-control"] = "private, no-store";
      return access.createSessionTransfer(caller);
    }
  )
  .post(
    "/auth/session-transfers/redeem",
    { body: sessionTransferSchema, idempotent: false, public: true },
    ({ access, body, caller, cookie, request, set }) => {
      set.headers["cache-control"] = "no-store";
      const origin = caller.kind === "in-process" ? new URL(request.url).origin : caller.origin;
      const transferred = access.redeemSessionTransfer(body.secret, origin);
      if (transferred instanceof ElysiaStatus) {
        return transferred;
      }
      const secure = origin.startsWith("https:");
      cookie[cookieName(access.identity().serverId, secure)]?.set({
        httpOnly: true,
        maxAge: Math.max(0, Math.floor((transferred.session.expiresAt - Date.now()) / 1000)),
        path: "/",
        sameSite: "strict",
        secure,
        value: transferred.session.token,
      });
      const log = createLogger({
        component: "access",
        context: { deviceId: transferred.deviceId, origin },
        operation: "browser-session-transferred",
      });
      log.emit();
      return { transferred: true as const };
    }
  )
  .post(
    "/auth/reconnections/claim",
    { body: reconnectionClaimSchema, idempotent: false, public: true },
    ({ body, caller, devices, request, set }) => {
      set.headers["cache-control"] = "no-store";
      const origin = caller.kind === "in-process" ? new URL(request.url).origin : caller.origin;
      return devices.claimReconnection(body.secret, body.browserSecret, body.label, origin);
    }
  )
  .post(
    "/auth/reconnections/complete",
    { body: reconnectionCompleteSchema, idempotent: false, public: true },
    ({ access, body, caller, cookie, devices, request, set }) => {
      set.headers["cache-control"] = "no-store";
      const origin = caller.kind === "in-process" ? new URL(request.url).origin : caller.origin;
      const result = devices.completeReconnection(body.id, body.browserSecret, origin);
      if (result instanceof ElysiaStatus || "pending" in result) {
        return result;
      }
      const secure = origin.startsWith("https:");
      cookie[cookieName(access.identity().serverId, secure)]?.set({
        httpOnly: true,
        maxAge: SESSION_COOKIE_MAX_AGE,
        path: "/",
        sameSite: "strict",
        secure,
        value: result.session.token,
      });
      const log = createLogger({
        component: "access",
        context: { deviceId: result.deviceId, origin },
        operation: "browser-reconnected",
      });
      log.emit();
      return { connected: true as const };
    }
  )
  .post("/auth/logout", { idempotent: false, personal: true }, ({ access, caller, cookie }) => {
    const result = access.signOut(caller);
    if (result instanceof ElysiaStatus) {
      return result;
    }
    const secure = caller.origin.startsWith("https:");
    cookie[cookieName(access.identity().serverId, secure)]?.set({
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "strict",
      secure,
      value: "",
    });
    return result;
  })
  .post("/auth/window-sessions", { idempotent: false, personal: true }, ({ access, caller }) => {
    const session = access.createWindowSession(caller);
    if (session instanceof ElysiaStatus) {
      return session;
    }
    return {
      cookie: cookieName(access.identity().serverId, caller.origin.startsWith("https:")),
      expiresAt: session.expiresAt,
      value: session.token,
    };
  })
  .guard({ administration: true, idempotent: false })
  .get("/access/invitations", ({ invitations }) => invitations.list())
  .post("/access/invitations", { body: invitationSchema }, ({ body, caller, invitations, set }) => {
    set.headers["cache-control"] = "private, no-store";
    return invitations.create(caller, body);
  })
  .delete("/access/invitations/:id", ({ caller, invitations, params }) =>
    invitations.revoke(caller, params.id)
  )
  .post(
    "/access/devices/:id/reconnections",
    { body: reconnectionSchema },
    ({ access, body, caller, devices, params, set }) => {
      set.headers["cache-control"] = "private, no-store";
      if (
        !(
          access.policy().enabled &&
          [caller.origin, ...access.policy().proxiedOrigins].includes(body.origin)
        )
      ) {
        return problem(400, { detail: "Choose an enabled server address" });
      }
      return devices.createReconnection(caller, params.id, body.origin);
    }
  )
  .get("/access/devices/:id/reconnections/:requestId", ({ caller, devices, params, set }) => {
    set.headers["cache-control"] = "private, no-store";
    const request = devices.reconnection(caller, params.id, params.requestId);
    if (request instanceof ElysiaStatus) {
      return request;
    }
    return {
      approved: request.approved,
      code: request.code,
      completed: request.completed,
      expiresAt: request.expiresAt,
      label: request.label,
    };
  })
  .post(
    "/access/devices/:id/reconnections/:requestId",
    { body: reconnectionDecisionSchema },
    ({ body, caller, devices, params, set }) => {
      set.headers["cache-control"] = "private, no-store";
      return devices.decideReconnection(
        caller,
        params.id,
        params.requestId,
        body.code,
        body.approve
      );
    }
  )
  .get("/access/devices", ({ devices }) => devices.list())
  .patch("/access/devices/:id", { body: deviceChangeSchema }, ({ body, caller, devices, params }) =>
    devices.update(caller, params.id, body)
  )
  .delete("/access/devices/:id", ({ caller, devices, params }) => devices.revoke(caller, params.id))
  .post("/access/devices/revoke-others", ({ caller, devices }) => devices.revokeOthers(caller))
  .patch("/access/server", { body: serverNameSchema }, ({ access, body }) => {
    const identity = access.rename(body.name);
    return { id: identity.serverId, name: identity.name };
  })
  .get("/connections", ({ access }) => {
    const identity = access.identity();
    return {
      /** Local network HTTPS origins the ingress serves now; each is covered by the certificate. */
      addresses: access.lanOrigins(),
      config: access.sharing,
      enabled: access.policy().enabled,
      exposures: access.exposures(tailscale.running),
      listening: { hostname: "127.0.0.1" as const, port: access.port },
      server: { id: identity.serverId, name: identity.name },
    };
  })
  .get("/connections/certificate", { owner: true }, () => ({
    certificate: localCertificate(),
  }))
  .post("/connections/certificate", { owner: true }, async ({ access }) => {
    const turn = access.reserve();
    try {
      await turn.previous;
      const config = access.sharing;
      if (config.lan.enabled) {
        return problem(409, {
          detail: "Turn off local network sharing before renewing its certificate",
        });
      }
      return await prepareCertificate(config.lan.hostnames);
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
  .post("/connections/tailscale/enroll", { owner: true }, async ({ access }) => {
    const started = await tailscale.start();
    if (started instanceof ElysiaStatus) {
      return started;
    }
    const status = await tailscale.request({
      hostname: `tofu-${access.identity().serverId.slice(0, 8)}`,
      method: "start",
    });
    return status;
  })
  .post("/connections/tailscale/logout", { owner: true }, async ({ access }) => {
    const turn = access.reserve();
    try {
      await turn.previous;
      const { tailscale: settings } = access.sharing;
      if (settings.enabled && settings.mode === "embedded") {
        return problem(409, {
          detail: "Turn off Tailscale sharing before signing out of Tailscale",
        });
      }
      const started = await tailscale.start();
      if (started instanceof ElysiaStatus) {
        return started;
      }
      return await tailscale.request({ method: "logout" });
    } finally {
      turn.release();
    }
  })
  .post("/connections/tailscale/https", { owner: true }, async () => {
    const started = await tailscale.start();
    if (started instanceof ElysiaStatus) {
      return started;
    }
    return await tailscale.request({ method: "authorize-https" });
  })
  .get("/connections/tailscale/embedded", { owner: true }, async () => {
    const started = await tailscale.start();
    if (started instanceof ElysiaStatus) {
      return started;
    }
    return await tailscale.request({ method: "status" });
  })
  .post("/connections/tailscale/check", async ({ access }) => {
    const turn = access.reserve();
    try {
      await turn.previous;
      const config = access.sharing;
      const status = await checkTailscale(access.port);
      if (status.state === "ready" && config.tailscale.origin !== status.origin) {
        access.save({ ...config, tailscale: { ...config.tailscale, origin: status.origin } });
      }
      return status;
    } finally {
      turn.release();
    }
  })
  .put(
    "/connections",
    { body: connectionsUpdateSchema },
    async ({ access, body, caller, cookie }) => {
      const updated = await updateRemoteAccess(access, body, caller.kind === "owner");
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
