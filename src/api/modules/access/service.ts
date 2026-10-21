import "@teyik0/furin/server-only";
import { hostname } from "node:os";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { problem } from "elysia";
import {
  authorizedDevices,
  deviceSessions,
  pairingInvitations,
  serverIdentity,
} from "../../../db/schema";
import type { DeviceRole, SessionKind } from "../../../types";
import type { TofuDatabase } from "../../lib/db";
import {
  cookieName,
  isPublicRequest,
  LINK_PATHS,
  LOOPBACK_HOSTS,
  LOOPBACK_PEER,
  NATIVE_PATHS,
  readCookie,
} from "./admission";
import { rank } from "./grants";
import { hash, randomToken } from "./tokens";

const LOCAL_HOST_SUFFIX = /\.local$/i;

export const PROTOCOL_MAJOR = 1;
export const DAY = 86_400_000;
const SESSION_IDLE = 30 * DAY;
const SESSION_ABSOLUTE = 365 * DAY;
const WINDOW_SESSION_ABSOLUTE = 7 * DAY;
const LAST_SEEN_PRECISION = 10 * 60_000;

export type Device = typeof authorizedDevices.$inferSelect;
export type DeviceSession = typeof deviceSessions.$inferSelect;
export type Invitation = typeof pairingInvitations.$inferSelect;

/** Every network caller carries the browser-facing origin admission established for it. */
export type Caller =
  | { kind: "owner"; origin: string; principal: "local-window" }
  | {
      kind: "device";
      device: Device;
      origin: string;
      principal: `device:${string}`;
      session: DeviceSession;
    }
  | { kind: "anonymous"; origin: string };

/**
 * Callers established by network admission. Requests absent from this map were dispatched
 * in-process (server rendering), never by a network peer.
 */
export const callers = new WeakMap<Request, Caller>();

export interface RemoteAccessPolicy {
  /** Whether devices other than the owner may connect. */
  enabled: boolean;
  /** HTTPS origins through which browsers reach this server behind a TLS-terminating proxy. */
  proxiedOrigins: string[];
  /** Immediate peers allowed to forward client addresses and hosts, besides loopback. */
  trustedProxies: string[];
}

interface AccessServiceOptions {
  db: TofuDatabase;
  /** The host runs headless; with remote access off its loopback clients act as owner. */
  headless: () => boolean;
  now: () => number;
  policy: () => RemoteAccessPolicy;
}

/**
 * Identity, sessions and admission of network requests. Invitations (`invitations.ts`) and device
 * grants (`devices.ts`) build on it. Every expected failure is a returned Elysia problem so routes
 * keep literal statuses in Eden types.
 */
export class AccessService {
  private readonly options: AccessServiceOptions;
  private readonly aborts = new Map<string, AbortController>();
  private readonly sessionReaders = new Map<string, Set<AbortController>>();

  constructor(options: AccessServiceOptions) {
    this.options = options;
    const now = options.now();
    options.db
      .insert(serverIdentity)
      .values({
        createdAt: now,
        identityEpoch: 1,
        key: "server",
        name: hostname().replace(LOCAL_HOST_SUFFIX, "") || "Tofu server",
        serverId: crypto.randomUUID(),
      })
      .onConflictDoNothing()
      .run();
  }

  identity() {
    const identity = this.options.db
      .select()
      .from(serverIdentity)
      .where(eq(serverIdentity.key, "server"))
      .get();
    if (!identity) {
      throw new Error("The server identity is missing");
    }
    return identity;
  }

  rename(name: string) {
    this.options.db
      .update(serverIdentity)
      .set({ name: name.trim() })
      .where(eq(serverIdentity.key, "server"))
      .run();
    return this.identity();
  }

  disconnectRemoteReaders() {
    for (const id of [...this.aborts.keys()]) {
      this.interrupt(id);
    }
  }

  /** Public, unauthenticated descriptor. Contains no paths, accounts or secrets. */
  descriptor(version: string) {
    const identity = this.identity();
    return {
      appVersion: version,
      name: identity.name,
      onboarding: ["invitation-link", "invitation-code"] as const,
      product: "tofu" as const,
      protocol: { major: PROTOCOL_MAJOR, maxClient: PROTOCOL_MAJOR, minClient: PROTOCOL_MAJOR },
      serverId: identity.serverId,
    };
  }

  /**
   * Browser-facing origin of a request. Forwarded hosts count only when the immediate peer is
   * loopback or a configured trusted proxy, and only for configured HTTPS origins.
   */
  effectiveOrigin(request: Request, peerAddress: string | undefined) {
    const url = new URL(request.url);
    const policy = this.options.policy();
    if (
      policy.enabled &&
      peerAddress &&
      (LOOPBACK_PEER.test(peerAddress) || policy.trustedProxies.includes(peerAddress))
    ) {
      const host = request.headers.get("x-forwarded-host") ?? url.host;
      const match = policy.proxiedOrigins.find((origin) => new URL(origin).host === host);
      if (match) {
        return new URL(match).origin;
      }
    }
    return url.origin;
  }

  /** Clients sharing this server, before any route runs. Returns a Response to reject. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The admission decision remains explicit and ordered before route dispatch.
  admit(
    request: Request,
    context: { desktopSession: boolean; desktopHost?: boolean; peerAddress: string | undefined }
  ): Response | undefined {
    const url = new URL(request.url);
    const policy = this.options.policy();
    if (context.desktopSession) {
      callers.set(request, { kind: "owner", origin: url.origin, principal: "local-window" });
      return;
    }
    const loopback =
      context.peerAddress !== undefined &&
      LOOPBACK_PEER.test(context.peerAddress) &&
      LOOPBACK_HOSTS.has(url.hostname);
    if (!policy.enabled) {
      if (
        !context.desktopHost &&
        this.options.headless() &&
        loopback &&
        !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some((name) =>
          request.headers.has(name)
        )
      ) {
        const origin = request.headers.get("origin");
        if (
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          origin &&
          origin !== url.origin
        ) {
          return new Response("Forbidden", { status: 403 });
        }
        callers.set(request, { kind: "owner", origin: url.origin, principal: "local-window" });
        return;
      }
      return new Response("Remote access is turned off on this server.", { status: 403 });
    }
    const origin = this.effectiveOrigin(request, context.peerAddress);
    const secure = origin.startsWith("https:");
    // Playback links are capability URLs read cross-origin by players without credentials.
    if (
      url.pathname.startsWith("/media/x/") &&
      ["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      callers.set(request, { kind: "anonymous", origin });
      return;
    }
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (request.headers.has("origin") && request.headers.get("origin") !== origin)
    ) {
      return Response.json(
        { detail: "Cross-site requests are not allowed", status: 403, title: "Forbidden" },
        { headers: { "content-type": "application/problem+json" }, status: 403 }
      );
    }
    if (isPublicRequest(request.method, url.pathname)) {
      callers.set(request, { kind: "anonymous", origin });
      return;
    }
    const authorization = request.headers.get("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const cookie = readCookie(
      request.headers.get("cookie"),
      cookieName(this.identity().serverId, secure)
    );
    let authenticated: ReturnType<AccessService["authenticate"]> = null;
    if (bearer) {
      authenticated = this.authenticate(bearer, ["native", "link"]);
    } else if (cookie) {
      authenticated = this.authenticate(cookie, ["browser", "window"]);
    }
    if (
      authenticated &&
      (!bearer ||
        (authenticated.session.kind === "native" ? NATIVE_PATHS : LINK_PATHS).has(url.pathname))
    ) {
      if (
        !(
          bearer ||
          ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
          request.headers.has("origin")
        ) &&
        URL.parse(request.headers.get("referer") ?? "")?.origin !== origin
      ) {
        return Response.json(
          { detail: "Missing request origin", status: 403, title: "Forbidden" },
          { headers: { "content-type": "application/problem+json" }, status: 403 }
        );
      }
      callers.set(request, {
        device: authenticated.device,
        kind: "device",
        origin,
        principal: `device:${authenticated.device.id}`,
        session: authenticated.session,
      });
      return;
    }
    const navigation =
      request.method === "GET" &&
      (request.headers.get("sec-fetch-dest") === "document" ||
        (request.headers.get("accept") ?? "").includes("text/html")) &&
      !url.pathname.startsWith("/api/");
    if (navigation) {
      return new Response(null, {
        headers: {
          "cache-control": "no-store",
          location: cookie ? "/signed-out?reason=expired" : "/signed-out",
        },
        status: 302,
      });
    }
    return Response.json(
      {
        detail: cookie || bearer ? "Your access to this server ended" : "Sign in to this server",
        status: 401,
        title: "Unauthorized",
      },
      { headers: { "content-type": "application/problem+json" }, status: 401 }
    );
  }

  /** Validates a session token and slides its idle expiry at most every ten minutes. */
  authenticate(token: string, kinds: SessionKind[]) {
    const now = this.options.now();
    const row = this.options.db
      .select({ device: authorizedDevices, session: deviceSessions })
      .from(deviceSessions)
      .innerJoin(authorizedDevices, eq(authorizedDevices.id, deviceSessions.deviceId))
      .where(
        and(
          eq(deviceSessions.tokenHash, hash(token)),
          gt(deviceSessions.expiresAt, now),
          gt(deviceSessions.idleExpiresAt, now),
          isNull(authorizedDevices.revokedAt)
        )
      )
      .get();
    if (!(row && kinds.includes(row.session.kind))) {
      return null;
    }
    if (now - row.session.lastSeenAt > LAST_SEEN_PRECISION) {
      this.options.db.transaction((tx) => {
        tx.update(deviceSessions)
          .set({
            idleExpiresAt: Math.min(now + SESSION_IDLE, row.session.expiresAt),
            lastSeenAt: now,
          })
          .where(eq(deviceSessions.id, row.session.id))
          .run();
        tx.update(authorizedDevices)
          .set({ lastSeenAt: now })
          .where(eq(authorizedDevices.id, row.device.id))
          .run();
      });
    }
    return row;
  }

  /** Aborted when the device is revoked or its grants change; streams compose it. */
  deviceSignal(deviceId: string) {
    let controller = this.aborts.get(deviceId);
    if (!controller) {
      controller = new AbortController();
      this.aborts.set(deviceId, controller);
    }
    return controller.signal;
  }

  /** Registers one long-lived response, including session expiry and window-only sign-out. */
  callerReader(caller: Caller, request: Request) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const readers =
      caller.kind === "device"
        ? (this.sessionReaders.get(caller.session.id) ?? new Set<AbortController>())
        : null;
    if (caller.kind === "device" && readers) {
      readers.add(controller);
      this.sessionReaders.set(caller.session.id, readers);
      const expiry = () => {
        const current = this.options.db
          .select()
          .from(deviceSessions)
          .where(eq(deviceSessions.id, caller.session.id))
          .get();
        const remaining = current
          ? Math.min(current.expiresAt, current.idleExpiresAt) - this.options.now()
          : 0;
        if (remaining <= 0) {
          controller.abort(new Error("This session expired"));
          return;
        }
        timer = setTimeout(expiry, Math.min(remaining, 2_147_483_647));
        timer.unref?.();
      };
      expiry();
    }
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", release);
      if (caller.kind === "device" && readers) {
        readers.delete(controller);
        if (readers.size === 0 && this.sessionReaders.get(caller.session.id) === readers) {
          this.sessionReaders.delete(caller.session.id);
        }
      }
    };
    request.signal.addEventListener("abort", release, { once: true });
    if (request.signal.aborted) {
      release();
    }
    return {
      release,
      signal: AbortSignal.any([
        request.signal,
        controller.signal,
        ...(caller.kind === "device" ? [this.deviceSignal(caller.device.id)] : []),
      ]),
    };
  }

  /** Ends the device's open streams; used when its access ends or its grants change. */
  interrupt(deviceId: string) {
    const controller = this.aborts.get(deviceId);
    this.aborts.delete(deviceId);
    controller?.abort(new Error("Access to this server changed"));
  }

  /** Stores a new session for a device and returns its one-time token. */
  issueSession(deviceId: string, kind: SessionKind) {
    const now = this.options.now();
    const token = randomToken(32);
    const expiresAt = now + (kind === "window" ? WINDOW_SESSION_ABSOLUTE : SESSION_ABSOLUTE);
    this.options.db
      .insert(deviceSessions)
      .values({
        createdAt: now,
        deviceId,
        expiresAt,
        id: crypto.randomUUID(),
        idleExpiresAt: Math.min(now + SESSION_IDLE, expiresAt),
        kind,
        lastSeenAt: now,
        tokenHash: hash(token),
      })
      .run();
    return { expiresAt, token };
  }

  /** Short-lived WebView cookie minted by a desktop client from its native credential. */
  /** What the caller may do here; the browser reads it after mount, never during rendering. */
  sessionView(
    caller: Exclude<Caller, { kind: "anonymous" }>,
    host: { native: boolean; remoteAccess: boolean }
  ) {
    const identity = this.identity();
    const owner = caller.kind === "owner";
    const role: DeviceRole | "owner" = owner ? "owner" : caller.device.role;
    const level = rank(role);
    return {
      caller: owner
        ? {
            authorizationVersion: "owner",
            canDeleteFiles: true,
            deviceKind: null,
            id: null,
            kind: "owner" as const,
            label: "This computer",
            profileId: "owner",
            role,
          }
        : {
            authorizationVersion: `${caller.device.id}:${caller.device.grantVersion}`,
            canDeleteFiles: caller.device.canDeleteFiles,
            deviceKind: caller.device.kind,
            id: caller.device.id,
            kind: "device" as const,
            label: caller.device.label,
            profileId: caller.device.profileId,
            role,
          },
      capabilities: {
        administer: level >= 3,
        deleteFiles: owner || caller.device.canDeleteFiles,
        hostNative: owner && host.native,
        manage: level >= 2,
        owner,
      },
      remoteAccess: { enabled: host.remoteAccess },
      server: { id: identity.serverId, name: identity.name },
    };
  }

  createWindowSession(caller: Caller) {
    if (!(caller.kind === "device" && caller.session.kind === "native")) {
      return problem(403, { detail: "Only the Tofu desktop app can open windows" });
    }
    return this.issueSession(caller.device.id, "window");
  }

  /** Ends the caller's own session; a desktop credential also ends its window sessions. */
  signOut(caller: Caller) {
    if (caller.kind !== "device") {
      return problem(409, { detail: "This computer's own window cannot sign out" });
    }
    if (caller.session.kind !== "window") {
      return this.revoke(caller.device.id);
    }
    this.options.db.delete(deviceSessions).where(eq(deviceSessions.id, caller.session.id)).run();
    for (const controller of this.sessionReaders.get(caller.session.id) ?? []) {
      controller.abort(new Error("This window signed out"));
    }
    this.sessionReaders.delete(caller.session.id);
    return { signedOut: true as const };
  }

  /** Revokes a device, deletes its sessions and ends its streams. */
  revoke(id: string) {
    const now = this.options.now();
    this.options.db.transaction((tx) => {
      tx.update(authorizedDevices)
        .set({ revokedAt: now })
        .where(and(eq(authorizedDevices.id, id), isNull(authorizedDevices.revokedAt)))
        .run();
      tx.delete(deviceSessions).where(eq(deviceSessions.deviceId, id)).run();
    });
    this.interrupt(id);
    return { signedOut: true as const };
  }

  /**
   * When a headless server opens to other devices, its loopback browser stops being the owner.
   * It becomes an Administration device with file deletion so it keeps its current access.
   */
  adoptOwnerBrowser() {
    const now = this.options.now();
    const id = crypto.randomUUID();
    this.options.db
      .insert(authorizedDevices)
      .values({
        canDeleteFiles: true,
        createdAt: now,
        grantVersion: 1,
        id,
        invitationId: null,
        issuer: "owner",
        kind: "browser",
        label: "Browser on this computer",
        lastSeenAt: now,
        pairedAt: now,
        profileId: "owner",
        redemptionNonceHash: null,
        revokedAt: null,
        role: "administration",
      })
      .run();
    return { id, token: this.issueSession(id, "browser").token };
  }

  /** Drops expired sessions and old invitations. */
  prune() {
    const now = this.options.now();
    this.options.db
      .delete(deviceSessions)
      .where(or(lt(deviceSessions.expiresAt, now), lt(deviceSessions.idleExpiresAt, now)))
      .run();
    this.options.db
      .delete(pairingInvitations)
      .where(lt(pairingInvitations.expiresAt, now - 30 * DAY))
      .run();
  }
}
