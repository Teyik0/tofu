import { Context, Effect, Layer } from "effect";
import { AccessControl } from "./service";
import "@teyik0/furin/server-only";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { problem } from "elysia";
import { authorizedDevices, deviceSessions, pairingInvitations } from "../../../db/schema";
import { Database } from "../../lib/db";
import { grantsOf, holds } from "./grants";
import type { DeviceKind, DeviceRole, SessionKind } from "./model";
import { type AccessService, type Caller, DAY, type Device, type Invitation } from "./service";
import { hash, randomToken } from "./tokens";

const PAIRING_RETRY_WINDOW = 120_000;
const MAX_CODE_ATTEMPTS = 5;
const FAILED_CODE_BUCKET = 30;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const sessionKinds: { [Kind in DeviceKind]: SessionKind } = {
  browser: "browser",
  desktop: "native",
  server: "link",
};

export interface InvitationInput {
  canDeleteFiles: boolean;
  expiresInMinutes: number;
  label: string;
  profileId?: string;
  role: DeviceRole;
}

export interface PairingInput {
  code?: string;
  kind: DeviceKind;
  label: string;
  nonce: string;
  secret?: string;
}

function randomCode(length: number) {
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
}

/** Crockford base32 normalization: ignores separators and accepts common look-alikes. */
export function normalizeCode(code: string) {
  return code
    .toUpperCase()
    .replaceAll(/[\s-]/g, "")
    .replaceAll("O", "0")
    .replaceAll(/[IL]/g, "1")
    .replaceAll("U", "V");
}

interface InvitationsOptions {
  access: AccessService;
  db: Database["Service"];
  now: () => number;
}

/**
 * One-time invitations and their atomic redemption into a device. Grants never exceed the
 * issuer's; short codes burn after repeated failures and a global bucket limits guessing.
 */
const make = Effect.gen(function* () {
  const db = yield* Database;
  const access = yield* AccessControl;
  const options: InvitationsOptions = { access, db, now: Date.now };

  const serviceOptions = options;

  let serviceFailedCodes: number[] = [];

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep one-time invitation validation and redemption atomic.
  function serviceCreate(issuer: Caller, input: InvitationInput) {
    const grants = grantsOf(issuer);
    if (!grants) {
      return problem(401, { detail: "Sign in to this server" });
    }
    if (input.canDeleteFiles && input.role === "playback") {
      return problem(400, {
        detail: "Deleting files requires Management or Administration access",
      });
    }
    if (!holds(grants, { canDeleteFiles: input.canDeleteFiles, role: input.role })) {
      return problem(403, { detail: "You can grant only permissions you hold" });
    }
    const label = input.label.trim();
    if (!label || label.length > 64) {
      return problem(400, { detail: "Enter a device name of 64 characters or fewer" });
    }
    const now = serviceOptions.now();
    const secret = randomToken(16);
    // The first three characters select the invitation; the other seven are its secret.
    const selectors = new Set(serviceActive(now).map((active) => active.codeHash.slice(0, 3)));
    let code = "";
    for (let attempt = 0; attempt < 16 && !code; attempt += 1) {
      const candidate = randomCode(10);
      if (!selectors.has(candidate.slice(0, 3))) {
        code = candidate;
      }
    }
    if (!code) {
      return problem(503, { detail: "Too many active invitations. Revoke one and try again" });
    }
    const invitation = {
      canDeleteFiles: input.canDeleteFiles,
      codeHash: `${code.slice(0, 3)}:${hash(code)}`,
      createdAt: now,
      expiresAt: now + input.expiresInMinutes * 60_000,
      failedAttempts: 0,
      id: crypto.randomUUID(),
      issuer: issuer.kind === "device" ? issuer.device.id : "owner",
      label,
      profileId: input.profileId ?? null,
      role: input.role,
      secretHash: hash(secret),
    };
    serviceOptions.db.insert(pairingInvitations).values(invitation).run();
    return {
      code: `${code.slice(0, 5)}-${code.slice(5)}`,
      invitation: serviceSummary({
        ...invitation,
        consumedAt: null,
        consumedBy: null,
        revokedAt: null,
      }),
      secret,
    };
  }
  function serviceActive(now: number) {
    return serviceOptions.db
      .select()
      .from(pairingInvitations)
      .where(
        and(
          isNull(pairingInvitations.consumedAt),
          isNull(pairingInvitations.revokedAt),
          gt(pairingInvitations.expiresAt, now)
        )
      )
      .all();
  }
  function serviceSummary(invitation: Invitation) {
    const now = serviceOptions.now();
    let status: "active" | "used" | "expired" | "revoked" = "active";
    if (invitation.revokedAt !== null) {
      status = "revoked";
    } else if (invitation.consumedAt !== null) {
      status = "used";
    } else if (invitation.expiresAt <= now) {
      status = "expired";
    }
    return {
      canDeleteFiles: invitation.canDeleteFiles,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      id: invitation.id,
      label: invitation.label,
      role: invitation.role,
      status,
    };
  }
  function serviceList() {
    const recent = serviceOptions.now() - DAY;
    return serviceOptions.db
      .select()
      .from(pairingInvitations)
      .where(or(gt(pairingInvitations.createdAt, recent), isNull(pairingInvitations.consumedAt)))
      .all()
      .map((invitation) => serviceSummary(invitation))
      .sort((left, right) => right.createdAt - left.createdAt);
  }
  function serviceRevoke(issuer: Caller, id: string) {
    const invitation = serviceOptions.db
      .select()
      .from(pairingInvitations)
      .where(eq(pairingInvitations.id, id))
      .get();
    const grants = grantsOf(issuer);
    if (!(invitation && grants)) {
      return problem(404, { detail: "Invitation not found" });
    }
    if (!holds(grants, { canDeleteFiles: invitation.canDeleteFiles, role: invitation.role })) {
      return problem(403, { detail: "You can revoke only invitations within your permissions" });
    }
    serviceOptions.db
      .update(pairingInvitations)
      .set({ revokedAt: invitation.revokedAt ?? serviceOptions.now() })
      .where(eq(pairingInvitations.id, id))
      .run();
    return serviceSummary({
      ...invitation,
      revokedAt: invitation.revokedAt ?? serviceOptions.now(),
    });
  }
  function serviceFind(input: PairingInput) {
    if (input.secret) {
      return serviceOptions.db
        .select()
        .from(pairingInvitations)
        .where(eq(pairingInvitations.secretHash, hash(input.secret)))
        .get();
    }
    const code = normalizeCode(input.code ?? "");
    if (code.length !== 10) {
      return;
    }
    const candidates = serviceOptions.db
      .select()
      .from(pairingInvitations)
      .all()
      .filter((invitation) => invitation.codeHash.startsWith(`${code.slice(0, 3)}:`));
    const match = candidates.find(
      (invitation) => invitation.codeHash === `${code.slice(0, 3)}:${hash(code)}`
    );
    if (match) {
      return match;
    }
    // A wrong secret for a live selector counts against that invitation and burns it.
    const now = serviceOptions.now();
    for (const invitation of candidates) {
      if (invitation.consumedAt === null && invitation.revokedAt === null) {
        const failedAttempts = invitation.failedAttempts + 1;
        serviceOptions.db
          .update(pairingInvitations)
          .set({
            failedAttempts,
            revokedAt: failedAttempts >= MAX_CODE_ATTEMPTS ? now : null,
          })
          .where(eq(pairingInvitations.id, invitation.id))
          .run();
      }
    }
  }
  function servicePreview(input: PairingInput) {
    const now = serviceOptions.now();
    serviceFailedCodes = serviceFailedCodes.filter((time) => now - time < 60_000);
    if (serviceFailedCodes.length >= FAILED_CODE_BUCKET) {
      return problem(429, { detail: "Too many attempts. Wait a minute and try again" });
    }
    const invitation = input.secret ? serviceFind(input) : undefined;
    if (!invitation) {
      serviceFailedCodes.push(now);
      return problem(401, { detail: "This invitation is not valid. Check the link or code" });
    }
    const summary = serviceSummary(invitation);
    if (summary.status !== "active") {
      return problem(410, {
        detail: `This invitation was ${summary.status === "used" ? "already used" : summary.status}. Ask for a new one`,
      });
    }
    const identity = serviceOptions.access.identity();
    return {
      canDeleteFiles: invitation.canDeleteFiles,
      expiresAt: invitation.expiresAt,
      role: invitation.role,
      server: { id: identity.serverId, name: identity.name },
    };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep one-time invitation validation and redemption atomic.
  function serviceRedeem(input: PairingInput) {
    const now = serviceOptions.now();
    serviceFailedCodes = serviceFailedCodes.filter((time) => now - time < 60_000);
    if (serviceFailedCodes.length >= FAILED_CODE_BUCKET) {
      return problem(429, { detail: "Too many attempts. Wait a minute and try again" });
    }
    if (!(input.secret || input.code) || input.nonce.length < 22) {
      return problem(400, { detail: "Enter an invitation link or code" });
    }
    const label = input.label.trim();
    if (!label || label.length > 64) {
      return problem(400, { detail: "Enter a device name of 64 characters or fewer" });
    }
    const invitation = serviceFind(input);
    if (!invitation) {
      serviceFailedCodes.push(now);
      return problem(401, { detail: "This invitation is not valid. Check the link or code" });
    }
    if (invitation.consumedAt !== null) {
      const device = invitation.consumedBy
        ? serviceOptions.db
            .select()
            .from(authorizedDevices)
            .where(eq(authorizedDevices.id, invitation.consumedBy))
            .get()
        : undefined;
      // A lost response may be retried once with the same nonce for the same device.
      if (
        device &&
        device.revokedAt === null &&
        device.redemptionNonceHash === hash(input.nonce) &&
        now - invitation.consumedAt <= PAIRING_RETRY_WINDOW
      ) {
        const session = serviceOptions.db.transaction((tx) => {
          tx.delete(deviceSessions).where(eq(deviceSessions.deviceId, device.id)).run();
          return serviceOptions.access.issueSession(device.id, sessionKinds[device.kind]);
        });
        return { device, session };
      }
      return problem(410, { detail: "This invitation was already used. Ask for a new one" });
    }
    if (invitation.revokedAt !== null) {
      return problem(410, { detail: "This invitation was revoked. Ask for a new one" });
    }
    if (invitation.expiresAt <= now) {
      return problem(410, { detail: "This invitation expired. Ask for a new one" });
    }
    const id = crypto.randomUUID();
    const device: Device = {
      canDeleteFiles: invitation.canDeleteFiles,
      createdAt: now,
      grantVersion: 1,
      id,
      invitationId: invitation.id,
      issuer: invitation.issuer,
      kind: input.kind,
      label,
      lastSeenAt: now,
      pairedAt: now,
      profileId: invitation.profileId ?? id,
      redemptionNonceHash: hash(input.nonce),
      revokedAt: null,
      role: invitation.role,
    };
    const session = serviceOptions.db.transaction((tx) => {
      const claimed = tx
        .update(pairingInvitations)
        .set({ consumedAt: now, consumedBy: id })
        .where(and(eq(pairingInvitations.id, invitation.id), isNull(pairingInvitations.consumedAt)))
        .returning({ id: pairingInvitations.id })
        .all();
      if (claimed.length !== 1) {
        return null;
      }
      tx.insert(authorizedDevices).values(device).run();
      return serviceOptions.access.issueSession(id, sessionKinds[input.kind]);
    });
    if (!session) {
      return problem(410, { detail: "This invitation was already used. Ask for a new one" });
    }
    return { device, session };
  }

  return {
    create: serviceCreate,
    list: serviceList,
    preview: servicePreview,
    redeem: serviceRedeem,
    revoke: serviceRevoke,
    summary: serviceSummary,
  };
});

export type Invitations = Effect.Success<typeof make>;
export class PairingInvitations extends Context.Service<PairingInvitations, Invitations>()(
  "tofu/invitations"
) {}
export const pairingInvitationsLayer = Layer.effect(PairingInvitations, make);
