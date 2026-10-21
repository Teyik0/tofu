import "@teyik0/furin/server-only";
import { and, eq, isNull } from "drizzle-orm";
import { problem } from "elysia";
import { authorizedDevices, deviceSessions, pairingInvitations } from "../../../db/schema";
import type { DeviceRole } from "../../../types";
import type { TofuDatabase } from "../../lib/db";
import { grantsOf, holds } from "./grants";
import type { AccessService, Caller, Device } from "./service";

export interface GrantChange {
  canDeleteFiles?: boolean;
  label?: string;
  profileId?: string;
  role?: DeviceRole;
}

interface DevicesOptions {
  access: AccessService;
  db: TofuDatabase;
  now: () => number;
}

/**
 * Authorized devices and their grants. An editor may change or revoke only devices whose grants
 * it holds, never raise itself, and grant changes end the device's open streams.
 */
export class Devices {
  private readonly options: DevicesOptions;

  constructor(options: DevicesOptions) {
    this.options = options;
  }

  list() {
    return this.options.db
      .select()
      .from(authorizedDevices)
      .where(isNull(authorizedDevices.revokedAt))
      .all()
      .map((device) => this.summary(device));
  }

  summary(device: Device) {
    const sessions = this.options.db
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

  private find(id: string) {
    return this.options.db
      .select()
      .from(authorizedDevices)
      .where(and(eq(authorizedDevices.id, id), isNull(authorizedDevices.revokedAt)))
      .get();
  }

  /** Grant edits are bounded by the editor: both the current and new grants must be held. */
  update(editor: Caller, id: string, change: GrantChange) {
    const grants = grantsOf(editor);
    const device = this.find(id);
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
    this.options.db
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
      this.options.access.interrupt(id);
    }
    return this.summary(updated);
  }

  revoke(editor: Caller, id: string) {
    const grants = grantsOf(editor);
    const device = this.find(id);
    if (!(grants && device)) {
      return problem(404, { detail: "Device not found" });
    }
    if (!holds(grants, device)) {
      return problem(403, { detail: "You can revoke only devices within your permissions" });
    }
    return this.options.access.revoke(id);
  }

  /** Revokes every device the editor may revoke, except the editor itself. */
  revokeOthers(editor: Caller) {
    const grants = grantsOf(editor);
    if (!grants) {
      return problem(401, { detail: "Sign in to this server" });
    }
    let revoked = 0;
    for (const device of this.options.db
      .select()
      .from(authorizedDevices)
      .where(isNull(authorizedDevices.revokedAt))
      .all()) {
      if (!(editor.kind === "device" && editor.device.id === device.id) && holds(grants, device)) {
        this.options.access.revoke(device.id);
        revoked += 1;
      }
    }
    return { revoked };
  }

  /** Revokes every remote device and pending invitation; the owner keeps access. */
  revokeAll() {
    const now = this.options.now();
    const devices = this.options.db
      .select({ id: authorizedDevices.id })
      .from(authorizedDevices)
      .where(isNull(authorizedDevices.revokedAt))
      .all();
    this.options.db.transaction((tx) => {
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
      this.options.access.interrupt(device.id);
    }
    return { revoked: devices.length };
  }
}
