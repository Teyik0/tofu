import { Context, Effect, Layer } from "effect";
import { createLogger } from "evlog";
import { PROTOCOL_MAJOR } from "../../../lib/protocol";
import { instance } from "../../lib/instance";
import "@teyik0/furin/server-only";
import { hostname } from "node:os";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { problem } from "elysia";
import {
  authorizedDevices,
  connectionState,
  deviceSessions,
  pairingInvitations,
  serverIdentity,
  sessionTransfers,
} from "../../../db/schema";
import { Database } from "../../lib/database-layer";
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
import type { DeviceRole, SessionKind } from "./model";
import { hash, randomToken } from "./tokens";

const LOCAL_HOST_SUFFIX = /\.local$/i;

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
  db: Database["Service"];
  defaultLanPort: number;
  /** The host runs headless; with remote access off its loopback clients act as owner. */
  headless: () => boolean;
  now: () => number;
}

/**
 * Identity, sessions and admission of network requests. Invitations (`invitations.ts`) and device
 * grants (`devices.ts`) build on it. Every expected failure is a returned Elysia problem so routes
 * keep literal statuses in Eden types.
 */
export type Exposure = "lan" | "tailscale" | "proxy";

/**
 * Independent ways other devices reach this server. Each terminates HTTPS outside the
 * application and forwards to its loopback HTTP listener.
 */
export interface SharingConfig {
  /** HTTPS served by the native companion on every interface with the installation CA. */
  lan: {
    enabled: boolean;
    /** Extra host names covered by the local network certificate, such as `nas.local`. */
    hostnames: string[];
    /** Public HTTPS port on the local network, distinct from the application listener. */
    port: number;
  };
  /** A custom TLS-terminating reverse proxy. */
  proxy: {
    enabled: boolean;
    /** Browser-facing HTTPS origin of the proxy. */
    origin: string | null;
    /** Immediate peers (besides loopback) allowed to forward client addresses and hosts. */
    trustedProxies: string[];
  };
  tailscale: {
    enabled: boolean;
    mode: "embedded" | "system";
    /** Tailscale HTTPS origin, learned from a successful check. */
    origin: string | null;
    /** Tofu created the system Serve mapping and removes it once it is no longer used. */
    serveOwned: boolean;
  };
}

/** The exclusive single-transport configuration stored by earlier versions. */
interface LegacyConfig {
  enabled: boolean;
  lanHostnames?: string[];
  port: number;
  proxyOrigin: string | null;
  tailscaleMode?: "embedded" | "system";
  tailscaleOrigin: string | null;
  tailscaleServeOwned?: boolean;
  transport: Exposure;
  trustedProxies?: string[];
}

/** A change journaled before its exposure is activated. */
interface PendingChange {
  config: SharingConfig;
  /** Tofu was about to create the system Serve mapping for this change. */
  serveIntent: boolean;
}

/** Reads a stored configuration, including the exclusive single-transport format. */
function upgrade(value: SharingConfig | LegacyConfig, defaultLanPort: number) {
  if (!("transport" in value)) {
    return { lan: value.lan, proxy: value.proxy, tailscale: value.tailscale };
  }
  const lan = value.enabled && value.transport === "lan";
  return {
    lan: {
      enabled: lan,
      hostnames: value.lanHostnames ?? [],
      // A shared local network address keeps its visible port.
      port: lan ? value.port : defaultLanPort,
    },
    proxy: {
      enabled: value.enabled && value.transport === "proxy",
      origin: value.proxyOrigin,
      trustedProxies: value.trustedProxies ?? [],
    },
    tailscale: {
      enabled: value.enabled && value.transport === "tailscale",
      mode: value.tailscaleMode ?? "system",
      origin: value.tailscaleOrigin,
      serveOwned: value.tailscaleServeOwned ?? false,
    },
  } satisfies SharingConfig;
}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const options: AccessServiceOptions = {
    db,
    defaultLanPort: instance.profile === "dev" ? 3442 : 3443,
    headless: () => !instance.desktop,
    now: Date.now,
  };

  const serviceOptions = options;

  let serviceSharing: SharingConfig;
  let serviceListenerPort: number | null = null;
  let serviceOperation: Promise<void> = Promise.resolve();
  let serviceLanHosts: string[] = [];
  const serviceServing = new Set<Exposure>();
  const serviceFailures = new Map<Exposure, string>();
  const serviceAborts = new Map<string, AbortController>();
  const serviceSessionReaders = new Map<string, Set<AbortController>>();
  function serviceRead<Value>(key: "active" | "pending" | "last-good") {
    const row = serviceOptions.db
      .select()
      .from(connectionState)
      .where(eq(connectionState.key, key))
      .get();
    return row ? (JSON.parse(row.value) as Value) : undefined;
  }
  function serviceWrite(key: "active" | "pending" | "last-good", value: unknown) {
    const now = serviceOptions.now();
    const text = JSON.stringify(value);
    serviceOptions.db
      .insert(connectionState)
      .values({ key, updatedAt: now, value: text })
      .onConflictDoUpdate({ set: { updatedAt: now, value: text }, target: connectionState.key })
      .run();
  }
  function serviceRemove(key: "pending") {
    serviceOptions.db.delete(connectionState).where(eq(connectionState.key, key)).run();
  }
  function serviceReserve() {
    const previous = serviceOperation;
    const turn = Promise.withResolvers<void>();
    serviceOperation = turn.promise;
    return { previous, release: turn.resolve };
  }
  function servicePolicy(): RemoteAccessPolicy {
    const { lan, proxy, tailscale } = serviceSharing;
    return {
      enabled: lan.enabled || proxy.enabled || tailscale.enabled,
      proxiedOrigins: [
        ...(lan.enabled ? serviceLanOrigins() : []),
        ...(tailscale.enabled && tailscale.origin ? [tailscale.origin] : []),
        ...(proxy.enabled && proxy.origin ? [proxy.origin] : []),
      ],
      trustedProxies: proxy.enabled ? proxy.trustedProxies : [],
    };
  }
  function serviceLanOrigins() {
    return serviceLanHosts.map((host) => `https://${host}`);
  }
  function serviceJournal(config: SharingConfig, serveIntent: boolean) {
    serviceWrite("pending", { config, serveIntent } satisfies PendingChange);
  }
  function serviceAbandon() {
    serviceRemove("pending");
  }
  function serviceSave(config: SharingConfig) {
    serviceSharing = config;
    serviceWrite("active", config);
    serviceWrite("last-good", config);
    serviceRemove("pending");
    for (const exposure of ["lan", "proxy", "tailscale"] as const) {
      if (!config[exposure].enabled) {
        serviceClosed(exposure);
      }
    }
    return config;
  }
  function serviceOpened(exposure: Exposure, hosts: string[] = []) {
    serviceServing.add(exposure);
    serviceFailures.delete(exposure);
    if (exposure === "lan") {
      serviceLanHosts = hosts;
    }
  }
  function serviceClosed(exposure: Exposure, failure?: string) {
    serviceServing.delete(exposure);
    if (failure) {
      serviceFailures.set(exposure, failure);
    } else {
      serviceFailures.delete(exposure);
    }
    if (exposure === "lan") {
      serviceLanHosts = [];
    }
  }
  function serviceExposures(companion: boolean) {
    const state = (exposure: Exposure, native: boolean) => {
      if (!serviceSharing[exposure].enabled) {
        return { detail: null, state: "off" as const };
      }
      const failure = serviceFailures.get(exposure);
      if (failure) {
        return { detail: failure, state: "failed" as const };
      }
      if (!native) {
        return { detail: null, state: "ready" as const };
      }
      if (!serviceServing.has(exposure)) {
        return { detail: null, state: "starting" as const };
      }
      return companion
        ? { detail: null, state: "ready" as const }
        : {
            detail: "The network companion stopped. Restart Tofu to restore this connection",
            state: "failed" as const,
          };
    };
    return {
      lan: state("lan", true),
      proxy: state("proxy", false),
      tailscale: state("tailscale", serviceSharing.tailscale.mode === "embedded"),
    };
  }
  function serviceIdentity() {
    const identity = serviceOptions.db
      .select()
      .from(serverIdentity)
      .where(eq(serverIdentity.key, "server"))
      .get();
    if (!identity) {
      throw new Error("The server identity is missing");
    }
    return identity;
  }
  function serviceRename(name: string) {
    serviceOptions.db
      .update(serverIdentity)
      .set({ name: name.trim() })
      .where(eq(serverIdentity.key, "server"))
      .run();
    return serviceIdentity();
  }
  function serviceDisconnectRemoteReaders() {
    for (const id of [...serviceAborts.keys()]) {
      serviceInterrupt(id);
    }
  }
  function serviceDescriptor(version: string) {
    const identity = serviceIdentity();
    return {
      appVersion: version,
      name: identity.name,
      onboarding: ["invitation-link", "invitation-code"] as const,
      product: "tofu" as const,
      protocol: { major: PROTOCOL_MAJOR, maxClient: PROTOCOL_MAJOR, minClient: PROTOCOL_MAJOR },
      serverId: identity.serverId,
    };
  }
  function serviceEffectiveOrigin(request: Request, peerAddress: string | undefined) {
    const url = new URL(request.url);
    const policy = servicePolicy();
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the existing admission decisions ordered before authentication and authorization.
  function serviceAdmit(
    request: Request,
    context: { desktopSession: boolean; desktopHost?: boolean; peerAddress: string | undefined }
  ): Response | undefined {
    const url = new URL(request.url);
    const policy = servicePolicy();
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
        serviceOptions.headless() &&
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
    const origin = serviceEffectiveOrigin(request, context.peerAddress);
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
      cookieName(serviceIdentity().serverId, secure)
    );
    let authenticated: ReturnType<typeof serviceAuthenticate> = null;
    if (bearer) {
      authenticated = serviceAuthenticate(bearer, ["native", "link"]);
    } else if (cookie) {
      authenticated = serviceAuthenticate(cookie, ["browser", "window"]);
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
    if (url.pathname === "/" || url.pathname === "/api/session") {
      const presented = bearer ?? cookie;
      let reason = "missing-session";
      let deviceId: string | null = null;
      if (presented) {
        const stored = serviceOptions.db
          .select({ device: authorizedDevices, session: deviceSessions })
          .from(deviceSessions)
          .innerJoin(authorizedDevices, eq(authorizedDevices.id, deviceSessions.deviceId))
          .where(eq(deviceSessions.tokenHash, hash(presented)))
          .get();
        reason = "unknown-session";
        if (stored) {
          deviceId = stored.device.id;
          const now = serviceOptions.now();
          if (stored.device.revokedAt !== null) {
            reason = "revoked-device";
          } else if (stored.session.expiresAt <= now) {
            reason = "expired-session";
          } else if (stored.session.idleExpiresAt <= now) {
            reason = "inactive-session";
          } else {
            reason = "session-kind-or-path-not-allowed";
          }
        }
      }
      const log = createLogger({
        component: "access",
        context: {
          browser: request.headers.get("user-agent"),
          deviceId,
          fetchSite: request.headers.get("sec-fetch-site"),
          origin,
          path: url.pathname,
          reason,
          secure,
        },
        operation: "session-rejected",
      });
      log.setLevel("warn");
      log.emit();
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
  function serviceAuthenticate(token: string, kinds: SessionKind[]) {
    const now = serviceOptions.now();
    const row = serviceOptions.db
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
      serviceOptions.db.transaction((tx) => {
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
  function serviceDeviceSignal(deviceId: string) {
    let controller = serviceAborts.get(deviceId);
    if (!controller) {
      controller = new AbortController();
      serviceAborts.set(deviceId, controller);
    }
    return controller.signal;
  }
  function serviceCallerReader(caller: Caller, request: Request) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const readers =
      caller.kind === "device"
        ? (serviceSessionReaders.get(caller.session.id) ?? new Set<AbortController>())
        : null;
    if (caller.kind === "device" && readers) {
      readers.add(controller);
      serviceSessionReaders.set(caller.session.id, readers);
      const expiry = () => {
        const current = serviceOptions.db
          .select()
          .from(deviceSessions)
          .where(eq(deviceSessions.id, caller.session.id))
          .get();
        const remaining = current
          ? Math.min(current.expiresAt, current.idleExpiresAt) - serviceOptions.now()
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
        if (readers.size === 0 && serviceSessionReaders.get(caller.session.id) === readers) {
          serviceSessionReaders.delete(caller.session.id);
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
        ...(caller.kind === "device" ? [serviceDeviceSignal(caller.device.id)] : []),
      ]),
    };
  }
  function serviceInterrupt(deviceId: string) {
    const controller = serviceAborts.get(deviceId);
    serviceAborts.delete(deviceId);
    controller?.abort(new Error("Access to this server changed"));
  }
  function serviceIssueSession(
    deviceId: string,
    kind: SessionKind,
    until = Number.POSITIVE_INFINITY
  ) {
    const now = serviceOptions.now();
    const token = randomToken(32);
    const expiresAt = Math.min(
      now + (kind === "window" ? WINDOW_SESSION_ABSOLUTE : SESSION_ABSOLUTE),
      until
    );
    serviceOptions.db
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
  function serviceCreateSessionTransfer(caller: Exclude<Caller, { kind: "anonymous" }>) {
    if (caller.kind !== "device" || caller.session.kind !== "browser") {
      return problem(403, { detail: "Only a paired browser can transfer its session" });
    }
    const now = serviceOptions.now();
    const expiresAt = Math.min(
      now + 60_000,
      caller.session.expiresAt,
      caller.session.idleExpiresAt
    );
    const secret = randomToken(32);
    serviceOptions.db.transaction((tx) => {
      tx.delete(sessionTransfers)
        .where(
          or(
            lt(sessionTransfers.expiresAt, now),
            eq(sessionTransfers.sourceSessionId, caller.session.id)
          )
        )
        .run();
      tx.insert(sessionTransfers)
        .values({
          expiresAt,
          grantVersion: caller.device.grantVersion,
          origin: caller.origin,
          sourceSessionId: caller.session.id,
          tokenHash: hash(secret),
        })
        .run();
    });
    return { expiresAt, secret };
  }
  function serviceRedeemSessionTransfer(secret: string, origin: string) {
    const now = serviceOptions.now();
    return serviceOptions.db.transaction((tx) => {
      const stored = tx
        .select({ device: authorizedDevices, session: deviceSessions, transfer: sessionTransfers })
        .from(sessionTransfers)
        .innerJoin(deviceSessions, eq(deviceSessions.id, sessionTransfers.sourceSessionId))
        .innerJoin(authorizedDevices, eq(authorizedDevices.id, deviceSessions.deviceId))
        .where(eq(sessionTransfers.tokenHash, hash(secret)))
        .get();
      if (
        !stored ||
        stored.transfer.expiresAt <= now ||
        stored.session.expiresAt <= now ||
        stored.session.idleExpiresAt <= now ||
        stored.device.revokedAt !== null ||
        stored.session.kind !== "browser" ||
        stored.transfer.grantVersion !== stored.device.grantVersion
      ) {
        return problem(410, {
          detail:
            "This transfer expired or is no longer valid. Prepare a new link in the connected browser",
        });
      }
      if (stored.transfer.origin !== origin) {
        return problem(403, {
          detail: "Open this transfer at the server address it was created for",
        });
      }
      const consumed = tx
        .delete(sessionTransfers)
        .where(eq(sessionTransfers.tokenHash, hash(secret)))
        .returning({ tokenHash: sessionTransfers.tokenHash })
        .all();
      if (consumed.length !== 1) {
        return problem(410, {
          detail: "This transfer was already used. Prepare a new link in the connected browser",
        });
      }
      const session = serviceIssueSession(stored.device.id, "browser", stored.session.expiresAt);
      return { deviceId: stored.device.id, session };
    });
  }
  function serviceSessionView(
    caller: Exclude<Caller, { kind: "anonymous" }>,
    host: { native: boolean; remoteAccess: boolean }
  ) {
    const identity = serviceIdentity();
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
  function serviceCreateWindowSession(caller: Caller) {
    if (!(caller.kind === "device" && caller.session.kind === "native")) {
      return problem(403, { detail: "Only the Tofu desktop app can open windows" });
    }
    return serviceIssueSession(caller.device.id, "window");
  }
  function serviceSignOut(caller: Caller) {
    if (caller.kind !== "device") {
      return problem(409, { detail: "This computer's own window cannot sign out" });
    }
    if (caller.session.kind !== "window") {
      return serviceRevoke(caller.device.id);
    }
    serviceOptions.db.delete(deviceSessions).where(eq(deviceSessions.id, caller.session.id)).run();
    for (const controller of serviceSessionReaders.get(caller.session.id) ?? []) {
      controller.abort(new Error("This window signed out"));
    }
    serviceSessionReaders.delete(caller.session.id);
    return { signedOut: true as const };
  }
  function serviceRevoke(id: string) {
    const now = serviceOptions.now();
    serviceOptions.db.transaction((tx) => {
      tx.update(authorizedDevices)
        .set({ revokedAt: now })
        .where(and(eq(authorizedDevices.id, id), isNull(authorizedDevices.revokedAt)))
        .run();
      tx.delete(deviceSessions).where(eq(deviceSessions.deviceId, id)).run();
    });
    serviceInterrupt(id);
    return { signedOut: true as const };
  }
  function serviceAdoptOwnerBrowser() {
    const now = serviceOptions.now();
    const id = crypto.randomUUID();
    serviceOptions.db
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
    return { id, token: serviceIssueSession(id, "browser").token };
  }
  function servicePrune() {
    const now = serviceOptions.now();
    serviceOptions.db
      .delete(deviceSessions)
      .where(or(lt(deviceSessions.expiresAt, now), lt(deviceSessions.idleExpiresAt, now)))
      .run();
    serviceOptions.db.delete(sessionTransfers).where(lt(sessionTransfers.expiresAt, now)).run();
    serviceOptions.db
      .delete(pairingInvitations)
      .where(lt(pairingInvitations.expiresAt, now - 30 * DAY))
      .run();
  }
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
  const stored = serviceRead<SharingConfig | LegacyConfig>("active");
  const lastGood = serviceRead<SharingConfig | LegacyConfig>("last-good");
  let active = stored
    ? upgrade(stored, options.defaultLanPort)
    : {
        lan: { enabled: false, hostnames: [], port: options.defaultLanPort },
        proxy: { enabled: false, origin: null, trustedProxies: [] },
        tailscale: { enabled: false, mode: "system" as const, origin: null, serveOwned: false },
      };
  const pending = serviceRead<PendingChange | { config: LegacyConfig }>("pending");
  if (pending && "serveIntent" in pending) {
    // An interrupted change never widens access: an exposure stays enabled only if both the
    // last good and the interrupted configuration enabled it, with the last good settings.
    const previous = lastGood ? upgrade(lastGood, options.defaultLanPort) : active;
    const next = pending.config;
    active = {
      ...previous,
      lan: { ...previous.lan, enabled: previous.lan.enabled && next.lan.enabled },
      proxy: { ...previous.proxy, enabled: previous.proxy.enabled && next.proxy.enabled },
      tailscale: {
        ...previous.tailscale,
        enabled: previous.tailscale.enabled && next.tailscale.enabled,
        // A mapping that may have been created is removed by startup reconciliation.
        serveOwned:
          previous.tailscale.serveOwned || next.tailscale.serveOwned || pending.serveIntent,
      },
    };
  } else if (pending) {
    // Earlier versions journaled unconfirmed listener changes; restore the last good one.
    active = lastGood ? upgrade(lastGood, options.defaultLanPort) : active;
  }
  serviceSharing = active;
  if (pending || JSON.stringify(stored) !== JSON.stringify(active)) {
    serviceSave(active);
  }

  return {
    abandon: serviceAbandon,
    admit: serviceAdmit,
    adoptOwnerBrowser: serviceAdoptOwnerBrowser,
    authenticate: serviceAuthenticate,
    callerReader: serviceCallerReader,
    closed: serviceClosed,
    createSessionTransfer: serviceCreateSessionTransfer,
    createWindowSession: serviceCreateWindowSession,
    descriptor: serviceDescriptor,
    deviceSignal: serviceDeviceSignal,
    disconnectRemoteReaders: serviceDisconnectRemoteReaders,
    effectiveOrigin: serviceEffectiveOrigin,
    exposures: serviceExposures,
    identity: serviceIdentity,
    interrupt: serviceInterrupt,
    issueSession: serviceIssueSession,
    journal: serviceJournal,
    lanOrigins: serviceLanOrigins,
    opened: serviceOpened,
    policy: servicePolicy,
    port() {
      if (serviceListenerPort === null) {
        throw new Error("The application listener is not initialized");
      }
      return serviceListenerPort;
    },
    prune: servicePrune,
    redeemSessionTransfer: serviceRedeemSessionTransfer,
    rename: serviceRename,
    reserve: serviceReserve,
    revoke: serviceRevoke,
    save: serviceSave,
    sessionView: serviceSessionView,
    setListenerPort(port: number) {
      serviceListenerPort = port;
    },
    sharing: () => serviceSharing,
    signOut: serviceSignOut,
  };
});

export type AccessService = Effect.Success<typeof make>;
export class AccessControl extends Context.Service<AccessControl, AccessService>()(
  "tofu/access-control"
) {}
export const accessControlLayer = Layer.effect(AccessControl, make);
