import type { DeviceRole } from "./model";
import type { Caller } from "./service";

/** Grants held by a caller; the owner holds everything. */
export interface Grants {
  canDeleteFiles: boolean;
  role: DeviceRole | "owner";
}

const roleRank: { [Role in DeviceRole]: number } = {
  administration: 3,
  management: 2,
  playback: 1,
};

export function grantsOf(caller: Caller): Grants | null {
  if (caller.kind === "owner") {
    return { canDeleteFiles: true, role: "owner" };
  }
  if (caller.kind === "device") {
    return { canDeleteFiles: caller.device.canDeleteFiles, role: caller.device.role };
  }
  return null;
}

/** Owner > Administration > Management > Playback. */
export function rank(role: Grants["role"]) {
  return role === "owner" ? 4 : roleRank[role];
}

/** Whether `issuer` holds every permission in `grants`. */
export function holds(issuer: Grants, grants: Grants) {
  return (
    rank(issuer.role) >= rank(grants.role) && (issuer.canDeleteFiles || !grants.canDeleteFiles)
  );
}
