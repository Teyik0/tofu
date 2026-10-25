import { Context, Effect, Layer } from "effect";
import { AccessControl } from "./service";
import "@teyik0/furin/server-only";
import { and, eq, isNull } from "drizzle-orm";
import { ElysiaStatus, problem } from "elysia";
import { authorizedDevices, deviceSessions, pairingInvitations } from "../../../db/schema";
import { Database } from "../../lib/database-layer";
import { grantsOf, holds } from "./grants";
import type { DeviceRole } from "./model";
import type { AccessService, Caller, Device } from "./service";
import { hash, randomToken } from "./tokens";

export interface GrantChange {
  canDeleteFiles?: boolean;
  label?: string;
  profileId?: string;
  role?: DeviceRole;
}

interface DevicesOptions {
  access: AccessService;
  db: Database["Service"];
  now: () => number;
}

interface Reconnection {
  approved: boolean;
  browserHash: string | null;
  code: string | null;
  completed: boolean;
  device: Device;
  editor: Exclude<Caller, { kind: "anonymous" }>;
  expiresAt: number;
  id: string;
  label: string | null;
  origin: string;
  secretHash: string;
}

/**
 * Authorized devices and their grants. An editor may change or revoke only devices whose grants
 * it holds, never raise itself, and grant changes end the device's open streams.
 */
const make = Effect.gen(function* () {
  const db = yield* Database;
  const access = yield* AccessControl;
  const options: DevicesOptions = { access, db, now: Date.now };

  const serviceOptions = options;

  const serviceReconnections = new Map<string, Reconnection>();
  function serviceList() {
    return serviceOptions.db
      .select()
      .from(authorizedDevices)
      .where(isNull(authorizedDevices.revokedAt))
      .all()
      .map((device) => serviceSummary(device));
  }
  function serviceSummary(device: Device) {
    const sessions = serviceOptions.db
      .select()
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, device.id))
      .all();
    return {
      canDeleteFiles: device.canDeleteFiles,
      expiresAt: sessions.reduce((latest, session) => Math.max(latest, session.expiresAt), 0),
      id: device.id,
      kind: device.kind,
      label: device.label,
      lastSeenAt: device.lastSeenAt,
      pairedAt: device.pairedAt,
      profileId: device.profileId,
      role: device.role,
    };
  }
  function serviceFind(id: string) {
    return serviceOptions.db
      .select()
      .from(authorizedDevices)
      .where(and(eq(authorizedDevices.id, id), isNull(authorizedDevices.revokedAt)))
      .get();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep grant validation and device session updates in one authorization decision.
  function serviceUpdate(editor: Caller, id: string, change: GrantChange) {
    const grants = grantsOf(editor);
    const device = serviceFind(id);
    if (!(grants && device)) {
      return problem(404, { detail: "Device not found" });
    }
    if (
      editor.kind === "device" &&
      editor.device.id === id &&
      (change.role || change.canDeleteFiles !== undefined)
    ) {
      return problem(403, { detail: "You cannot change your own permissions" });
    }
    const next = {
      canDeleteFiles: change.canDeleteFiles ?? device.canDeleteFiles,
      role: change.role ?? device.role,
    };
    if (next.canDeleteFiles && next.role === "playback") {
      return problem(400, {
        detail: "Deleting files requires Management or Administration access",
      });
    }
    if (!(holds(grants, device) && holds(grants, next))) {
      return problem(403, { detail: "You can grant only permissions you hold" });
    }
    const label = change.label?.trim();
    if (label !== undefined && (!label || label.length > 64)) {
      return problem(400, { detail: "Enter a device name of 64 characters or fewer" });
    }
    const grantsChanged =
      next.role !== device.role ||
      next.canDeleteFiles !== device.canDeleteFiles ||
      (change.profileId !== undefined && change.profileId !== device.profileId);
    const updated = {
      ...device,
      ...next,
      grantVersion: device.grantVersion + (grantsChanged ? 1 : 0),
      label: label ?? device.label,
      profileId: change.profileId ?? device.profileId,
    };
    serviceOptions.db
      .update(authorizedDevices)
      .set({
        canDeleteFiles: updated.canDeleteFiles,
        grantVersion: updated.grantVersion,
        label: updated.label,
        profileId: updated.profileId,
        role: updated.role,
      })
      .where(eq(authorizedDevices.id, id))
      .run();
    if (grantsChanged) {
      serviceOptions.access.interrupt(id);
    }
    return serviceSummary(updated);
  }
  function serviceRevoke(editor: Caller, id: string) {
    const grants = grantsOf(editor);
    const device = serviceFind(id);
    if (!(grants && device)) {
      return problem(404, { detail: "Device not found" });
    }
    if (!holds(grants, device)) {
      return problem(403, { detail: "You can revoke only devices within your permissions" });
    }
    return serviceOptions.access.revoke(id);
  }
  function serviceCreateReconnection(
    editor: Exclude<Caller, { kind: "anonymous" }>,
    id: string,
    origin: string
  ) {
    const device = serviceFind(id);
    const grants = grantsOf(editor);
    if (!(device && grants && holds(grants, device))) {
      return problem(403, { detail: "You can reconnect only devices within your permissions" });
    }
    if (device.kind !== "browser") {
      return problem(400, { detail: "Only browser devices support browser reconnection" });
    }
    const now = serviceOptions.now();
    for (const [key, request] of serviceReconnections) {
      if (
        request.expiresAt <= now ||
        (request.editor.principal === editor.principal && request.device.id === id)
      ) {
        serviceReconnections.delete(key);
      }
    }
    const secret = randomToken(32);
    const request: Reconnection = {
      approved: false,
      browserHash: null,
      code: null,
      completed: false,
      device,
      editor,
      expiresAt: now + 60_000,
      id: crypto.randomUUID(),
      label: null,
      origin,
      secretHash: hash(secret),
    };
    serviceReconnections.set(request.id, request);
    return { expiresAt: request.expiresAt, id: request.id, secret };
  }
  function serviceValidReconnection(request: Reconnection | undefined) {
    if (!request || request.expiresAt <= serviceOptions.now()) {
      return problem(410, {
        detail: "This reconnection expired. Generate a new QR code on the Mac",
      });
    }
    const device = serviceFind(request.device.id);
    if (!device || device.grantVersion !== request.device.grantVersion) {
      return problem(410, { detail: "This device's access changed. Generate a new QR code" });
    }
    if (request.editor.kind === "device") {
      const editor = serviceFind(request.editor.device.id);
      const session = serviceOptions.db
        .select()
        .from(deviceSessions)
        .where(eq(deviceSessions.id, request.editor.session.id))
        .get();
      const now = serviceOptions.now();
      if (
        !editor ||
        editor.grantVersion !== request.editor.device.grantVersion ||
        !session ||
        session.expiresAt <= now ||
        session.idleExpiresAt <= now ||
        !holds(editor, device)
      ) {
        return problem(410, { detail: "The approving connection is no longer authorized" });
      }
    }
    return request;
  }
  function serviceReconnection(editor: Caller, id: string, requestId: string) {
    const request = serviceValidReconnection(serviceReconnections.get(requestId));
    if (request instanceof ElysiaStatus) {
      return request;
    }
    if (
      editor.kind === "anonymous" ||
      request.device.id !== id ||
      request.editor.principal !== editor.principal ||
      (editor.kind === "device" &&
        request.editor.kind === "device" &&
        editor.session.id !== request.editor.session.id)
    ) {
      return problem(403, { detail: "Open this request in the connection that generated it" });
    }
    return request;
  }
  function serviceDecideReconnection(
    editor: Caller,
    id: string,
    requestId: string,
    code: string,
    approve: boolean
  ) {
    const request = serviceReconnection(editor, id, requestId);
    if (request instanceof ElysiaStatus) {
      return request;
    }
    if (!approve) {
      serviceReconnections.delete(requestId);
      return { approved: false };
    }
    if (!(request.browserHash && request.code) || request.code !== code || request.completed) {
      return problem(409, {
        detail: "Verify the code currently displayed on the connecting browser",
      });
    }
    request.approved = true;
    return { approved: true };
  }
  function serviceClaimReconnection(
    secret: string,
    browserSecret: string,
    label: string,
    origin: string
  ) {
    const request = serviceValidReconnection(
      [...serviceReconnections.values()].find((item) => item.secretHash === hash(secret))
    );
    if (request instanceof ElysiaStatus) {
      return request;
    }
    if (request.origin !== origin) {
      return problem(403, { detail: "Open the QR code at its original server address" });
    }
    if (request.browserHash && request.browserHash !== hash(browserSecret)) {
      return problem(409, {
        detail: "This QR code was already scanned. Generate a new one on the Mac",
      });
    }
    if (!label.trim()) {
      return problem(400, { detail: "Enter a browser name" });
    }
    if (!request.browserHash) {
      request.browserHash = hash(browserSecret);
      const value = Buffer.from(crypto.getRandomValues(new Uint8Array(4)))
        .toString("hex")
        .toUpperCase();
      request.code = `${value.slice(0, 4)}-${value.slice(4)}`;
      request.label = label.trim();
    }
    return { code: request.code, expiresAt: request.expiresAt, id: request.id };
  }
  function serviceCompleteReconnection(id: string, browserSecret: string, origin: string) {
    const request = serviceValidReconnection(serviceReconnections.get(id));
    if (request instanceof ElysiaStatus) {
      return request;
    }
    if (request.origin !== origin || request.browserHash !== hash(browserSecret)) {
      return problem(403, { detail: "Only the browser that scanned this QR code can connect" });
    }
    if (request.completed) {
      return problem(410, { detail: "This reconnection was already completed" });
    }
    if (!request.approved) {
      return { pending: true as const };
    }
    const now = serviceOptions.now();
    const deviceId = crypto.randomUUID();
    const device: Device = {
      ...request.device,
      createdAt: now,
      grantVersion: 1,
      id: deviceId,
      invitationId: null,
      issuer: request.editor.kind === "owner" ? "owner" : request.editor.device.id,
      label: request.label ?? "New browser",
      lastSeenAt: now,
      pairedAt: now,
      redemptionNonceHash: null,
      revokedAt: null,
    };
    const session = serviceOptions.db.transaction((tx) => {
      tx.insert(authorizedDevices).values(device).run();
      return serviceOptions.access.issueSession(deviceId, "browser");
    });
    request.completed = true;
    return { deviceId, session };
  }
  function serviceRevokeOthers(editor: Caller) {
    const grants = grantsOf(editor);
    if (!grants) {
      return problem(401, { detail: "Sign in to this server" });
    }
    let revoked = 0;
    for (const device of serviceOptions.db
      .select()
      .from(authorizedDevices)
      .where(isNull(authorizedDevices.revokedAt))
      .all()) {
      if (!(editor.kind === "device" && editor.device.id === device.id) && holds(grants, device)) {
        serviceOptions.access.revoke(device.id);
        revoked += 1;
      }
    }
    return { revoked };
  }
  function serviceRevokeAll() {
    const now = serviceOptions.now();
    const devices = serviceOptions.db
      .select({ id: authorizedDevices.id })
      .from(authorizedDevices)
      .where(isNull(authorizedDevices.revokedAt))
      .all();
    serviceOptions.db.transaction((tx) => {
      tx.update(authorizedDevices)
        .set({ revokedAt: now })
        .where(isNull(authorizedDevices.revokedAt))
        .run();
      tx.delete(deviceSessions).run();
      tx.update(pairingInvitations)
        .set({ revokedAt: now })
        .where(and(isNull(pairingInvitations.consumedAt), isNull(pairingInvitations.revokedAt)))
        .run();
    });
    for (const device of devices) {
      serviceOptions.access.interrupt(device.id);
    }
    return { revoked: devices.length };
  }

  return {
    claimReconnection: serviceClaimReconnection,
    completeReconnection: serviceCompleteReconnection,
    createReconnection: serviceCreateReconnection,
    decideReconnection: serviceDecideReconnection,
    list: serviceList,
    reconnection: serviceReconnection,
    revoke: serviceRevoke,
    revokeAll: serviceRevokeAll,
    revokeOthers: serviceRevokeOthers,
    summary: serviceSummary,
    update: serviceUpdate,
  };
});

export type Devices = Effect.Success<typeof make>;
export class AuthorizedDevices extends Context.Service<AuthorizedDevices, Devices>()(
  "tofu/devices"
) {}
export const authorizedDevicesLayer = Layer.effect(AuthorizedDevices, make);
