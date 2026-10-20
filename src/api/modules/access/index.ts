import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { sync } from "../../../sync";
import { runtime } from "../../lib/runtime";
import { connections } from "../connections/plugin";
import { cookieName } from "./admission";
import { deviceChangeSchema, invitationSchema, pairSchema, serverNameSchema } from "./model";
import { accessPlugin } from "./plugin";

const SESSION_COOKIE_MAX_AGE = 365 * 86_400;

export const accessRoutesPlugin = new Elysia({ name: "tofu-access-api" })
  .use(accessPlugin)
  .use(furinSync(sync))
  .get("/session", { personal: true }, ({ access, caller, set }) => {
    set.headers["cache-control"] = "private, no-store";
    return access.sessionView(caller, {
      native: runtime.current.kind === "desktop",
      remoteAccess: connections.policy().enabled,
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
      return { ...result, token: null };
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
  .get("/access/devices", ({ devices }) => devices.list())
  .patch("/access/devices/:id", { body: deviceChangeSchema }, ({ body, caller, devices, params }) =>
    devices.update(caller, params.id, body)
  )
  .delete("/access/devices/:id", ({ caller, devices, params }) => devices.revoke(caller, params.id))
  .post("/access/devices/revoke-others", ({ caller, devices }) => devices.revokeOthers(caller))
  .patch("/access/server", { body: serverNameSchema }, ({ access, body }) => {
    const identity = access.rename(body.name);
    return { id: identity.serverId, name: identity.name };
  });
