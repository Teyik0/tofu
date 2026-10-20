import "@teyik0/furin/server-only";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { problem } from "elysia";
import { connectionState } from "../../../db/schema";
import type { TofuDatabase } from "../../lib/db";
import { recordLog } from "../../lib/diagnostics";
import type { RemoteAccessPolicy } from "../access/service";

const LOCAL_HOST_SUFFIX = /\.local$/i;
const LINK_LOCAL = /^fe[89ab][0-9a-f]:/i;

export type Exposure = "lan" | "tailscale" | "proxy";

/**
 * Independent ways other devices reach this server. Each terminates HTTPS outside the
 * application and forwards to the single loopback HTTP listener at `port`.
 */
export interface RemoteAccessConfig {
  /** HTTPS served by the native companion on every interface with the installation CA. */
  lan: {
    enabled: boolean;
    /** Extra host names covered by the local network certificate, such as `nas.local`. */
    hostnames: string[];
    /** Public HTTPS port on the local network; always distinct from `port`, never changed silently. */
    port: number;
  };
  /** Loopback port of the application listener; every exposure forwards to it. */
  port: number;
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
  config: RemoteAccessConfig;
  /** Tofu was about to create the system Serve mapping for this change. */
  serveIntent: boolean;
}

interface ConnectionsServiceOptions {
  dataDir: string;
  db: TofuDatabase;
  /** Default local network HTTPS port of new configurations. */
  defaultLanPort: number;
  defaultPort: number;
  /** Fixed listener port of a headless server (TOFU_PORT); desktop hosts choose their own. */
  fixedPort: number | null;
  now: () => number;
}

/** Reads a stored configuration, including the exclusive single-transport format. */
function upgrade(value: RemoteAccessConfig | LegacyConfig, defaultLanPort: number) {
  if (!("transport" in value)) {
    return value;
  }
  const lan = value.enabled && value.transport === "lan";
  return {
    lan: {
      enabled: lan,
      hostnames: value.lanHostnames ?? [],
      // A shared local network address keeps its visible port.
      port: lan ? value.port : defaultLanPort,
    },
    port: value.port,
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
  } satisfies RemoteAccessConfig;
}

/**
 * Persisted exposure configuration, the admission policy derived from it, the journal that keeps
 * interrupted changes from widening access, and the runtime state of each exposure.
 */
export class ConnectionsService {
  private readonly options: ConnectionsServiceOptions;
  private active: RemoteAccessConfig;
  private listenerPort: number | null = null;
  private operation: Promise<void> = Promise.resolve();
  /** Browser-facing hosts the local network ingress currently accepts. */
  private lanHosts: string[] = [];
  private readonly serving = new Set<Exposure>();
  private readonly failures = new Map<Exposure, string>();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Migration, interrupted-change recovery and port separation form one ordered startup decision.
  constructor(options: ConnectionsServiceOptions) {
    this.options = options;
    const stored = this.read<RemoteAccessConfig | LegacyConfig>("active");
    const lastGood = this.read<RemoteAccessConfig | LegacyConfig>("last-good");
    let active = stored
      ? upgrade(stored, options.defaultLanPort)
      : {
          lan: { enabled: false, hostnames: [], port: options.defaultLanPort },
          port: options.fixedPort ?? options.defaultPort,
          proxy: { enabled: false, origin: null, trustedProxies: [] },
          tailscale: { enabled: false, mode: "system" as const, origin: null, serveOwned: false },
        };
    const pending = this.read<PendingChange | { config: LegacyConfig }>("pending");
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
    if (options.fixedPort !== null) {
      active = { ...active, port: options.fixedPort };
    }
    if (active.lan.port === active.port && active.port !== 0) {
      if (options.fixedPort === null) {
        // The desktop listener is private: it moves so the shared address keeps its port.
        active = { ...active, port: 0 };
      } else {
        // A headless listener keeps TOFU_PORT; the local network address moves instead.
        const port =
          options.defaultLanPort === active.port
            ? options.defaultLanPort + 1
            : options.defaultLanPort;
        recordLog({
          component: "connections",
          context: { from: active.lan.port, to: port },
          dataDir: options.dataDir,
          level: "warn",
          operation: "local-network-port-moved",
        });
        active = { ...active, lan: { ...active.lan, port } };
      }
    }
    this.active = active;
    if (pending || JSON.stringify(stored) !== JSON.stringify(active)) {
      this.save(active);
    }
  }

  private read<Value>(key: "active" | "pending" | "last-good") {
    const row = this.options.db
      .select()
      .from(connectionState)
      .where(eq(connectionState.key, key))
      .get();
    return row ? (JSON.parse(row.value) as Value) : undefined;
  }

  private write(key: "active" | "pending" | "last-good", value: unknown) {
    const now = this.options.now();
    const text = JSON.stringify(value);
    this.options.db
      .insert(connectionState)
      .values({ key, updatedAt: now, value: text })
      .onConflictDoUpdate({ set: { updatedAt: now, value: text }, target: connectionState.key })
      .run();
  }

  private remove(key: "pending") {
    this.options.db.delete(connectionState).where(eq(connectionState.key, key)).run();
  }

  config() {
    return this.active;
  }

  /**
   * Reserves the next turn for a change to exposures. Call it before the first `await` and
   * release the turn when the change has finished, so concurrent changes apply one at a time.
   */
  reserve() {
    const previous = this.operation;
    const turn = Promise.withResolvers<void>();
    this.operation = turn.promise;
    return { previous, release: turn.resolve };
  }

  listening() {
    return { hostname: "127.0.0.1" as const, port: this.servicePort() };
  }

  policy(): RemoteAccessPolicy {
    const { lan, proxy, tailscale } = this.active;
    return {
      enabled: lan.enabled || proxy.enabled || tailscale.enabled,
      proxiedOrigins: [
        ...(lan.enabled ? this.lanOrigins() : []),
        ...(tailscale.enabled && tailscale.origin ? [tailscale.origin] : []),
        ...(proxy.enabled && proxy.origin ? [proxy.origin] : []),
      ],
      trustedProxies: proxy.enabled ? proxy.trustedProxies : [],
    };
  }

  /** HTTPS origins the local network ingress currently serves; empty while it is closed. */
  lanOrigins() {
    return this.lanHosts.map((host) => `https://${host}`);
  }

  /**
   * Names and current interface addresses of this server that the installation certificate
   * covers: the `.local` name, extra names and non-loopback, non-link-local addresses. An
   * address the certificate does not cover is never offered to other devices.
   */
  lanNames(config: RemoteAccessConfig) {
    const path = join(this.options.dataDir, "tls/server.pem");
    if (!existsSync(path)) {
      return problem(409, { detail: "Create the local network certificate on the server first" });
    }
    const leaf = new X509Certificate(readFileSync(path));
    const now = this.options.now();
    if (Date.parse(leaf.validTo) <= now || Date.parse(leaf.validFrom) > now) {
      return problem(409, {
        detail: "The local network certificate is expired or not yet valid. Renew it on the server",
      });
    }
    const names = [
      `${hostname().replace(LOCAL_HOST_SUFFIX, "")}.local`,
      ...config.lan.hostnames,
    ].filter((name) => leaf.checkHost(name) !== undefined);
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter(
        (item) =>
          item &&
          !item.internal &&
          !item.address.includes("%") &&
          !LINK_LOCAL.test(item.address) &&
          leaf.checkIP(item.address) !== undefined
      )
      .map((item) => item?.address ?? "");
    const covered = [...new Set([...names, ...addresses])];
    if (covered.length === 0) {
      return problem(409, {
        detail:
          "The local network certificate covers none of this server's current names or addresses. Renew it on the server",
      });
    }
    return covered;
  }

  /** Loopback port of the application listener, once it is known. */
  servicePort() {
    return this.listenerPort ?? this.active.port;
  }

  /** The application listener; local window and SSR stay on loopback HTTP for every exposure. */
  listenOptions() {
    return { hostname: "127.0.0.1" as const, port: this.options.fixedPort ?? this.active.port };
  }

  /**
   * Records the listener's actual port, which exposures forward to. This does not mean any
   * exposure is ready; startup activates them before Tofu opens.
   */
  listened(port: number) {
    this.listenerPort = port;
    if (this.active.port === 0) {
      // An explicitly requested ephemeral port becomes the stable forwarding target.
      this.save({ ...this.active, port });
    }
  }

  /** Journals a change before its exposure is activated. */
  journal(config: RemoteAccessConfig, serveIntent: boolean) {
    this.write("pending", { config, serveIntent } satisfies PendingChange);
  }

  /** Drops the journal of a change that was refused or rolled back. */
  abandon() {
    this.remove("pending");
  }

  /** Persists a configuration as active and last good, ending any journaled change. */
  save(config: RemoteAccessConfig) {
    this.active = config;
    this.write("active", config);
    this.write("last-good", config);
    this.remove("pending");
    for (const exposure of ["lan", "proxy", "tailscale"] as const) {
      if (!config[exposure].enabled) {
        this.closed(exposure);
      }
    }
    return config;
  }

  /** Records that an exposure forwards traffic; the local network reports its served hosts. */
  opened(exposure: Exposure, hosts: string[] = []) {
    this.serving.add(exposure);
    this.failures.delete(exposure);
    if (exposure === "lan") {
      this.lanHosts = hosts;
    }
  }

  /** Records that an exposure stopped forwarding, optionally with the reason it failed. */
  closed(exposure: Exposure, failure?: string) {
    this.serving.delete(exposure);
    if (failure) {
      this.failures.set(exposure, failure);
    } else {
      this.failures.delete(exposure);
    }
    if (exposure === "lan") {
      this.lanHosts = [];
    }
  }

  /** Runtime state of each exposure. Forwarding by the native companion needs it running. */
  exposures(companion: boolean) {
    const state = (exposure: Exposure, native: boolean) => {
      if (!this.active[exposure].enabled) {
        return { detail: null, state: "off" as const };
      }
      const failure = this.failures.get(exposure);
      if (failure) {
        return { detail: failure, state: "failed" as const };
      }
      if (!native) {
        return { detail: null, state: "ready" as const };
      }
      if (!this.serving.has(exposure)) {
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
      tailscale: state("tailscale", this.active.tailscale.mode === "embedded"),
    };
  }

  /** Offline owner recovery turns off every exposure. */
  disable() {
    return this.save({
      ...this.active,
      lan: { ...this.active.lan, enabled: false },
      proxy: { ...this.active.proxy, enabled: false },
      tailscale: { ...this.active.tailscale, enabled: false },
    });
  }
}
