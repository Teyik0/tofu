import "@teyik0/furin/server-only";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { problem } from "elysia";
import { connectionState } from "../../../db/schema";
import type { TofuDatabase } from "../../lib/db";
import type { RemoteAccessPolicy } from "../access/service";

const LOCAL_HOST_SUFFIX = /\.local$/i;

export type RemoteTransport = "tailscale" | "proxy" | "lan";

export interface RemoteAccessConfig {
  enabled: boolean;
  /** Extra host names covered by the local network certificate, such as `nas.local`. */
  lanHostnames: string[];
  /** Stable listener port; never changed silently. */
  port: number;
  /** Browser-facing HTTPS origin of a custom TLS-terminating reverse proxy. */
  proxyOrigin: string | null;
  tailscaleMode?: "embedded" | "system";
  /** Tailscale Serve HTTPS origin, learned from a successful check. */
  tailscaleOrigin: string | null;
  /** Set only after Tofu created the system Serve mapping. */
  tailscaleServeOwned?: boolean;
  transport: RemoteTransport;
  /** Immediate peers (besides loopback) allowed to forward client addresses and hosts. */
  trustedProxies: string[];
}

/** A configuration waiting to be confirmed through the route it opened. */
interface PendingConfig {
  /** Boots that started with this configuration; a second unconfirmed boot reverts it. */
  boots: number;
  config: RemoteAccessConfig;
  /** Applied from the host's own window or CLI: confirmed as soon as the server is ready. */
  local: boolean;
}

export interface ListenerState {
  hostname: string;
  port: number;
  tls: boolean;
}

interface ConnectionsServiceOptions {
  dataDir: string;
  db: TofuDatabase;
  defaultPort: number;
  /** Fixed listener port of a headless server (TOFU_PORT); desktop hosts choose their own. */
  fixedPort: number | null;
  now: () => number;
  /** Restarts the backend so the listener rebinds with the active configuration. */
  restart: () => void;
}

export const CONFIRMATION_WINDOW = 90_000;

/**
 * Persisted remote access configuration, the admission policy derived from it, and the
 * confirm-or-revert journal for changes that rebind the single application listener.
 */
export class ConnectionsService {
  private readonly options: ConnectionsServiceOptions;
  private active: RemoteAccessConfig;
  private listener: ListenerState | null = null;
  private awaiting: {
    deadline: number;
    local: boolean;
    timer?: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(options: ConnectionsServiceOptions) {
    this.options = options;
    const stored = this.read<RemoteAccessConfig>("active") ?? {
      enabled: false,
      lanHostnames: [],
      port: options.fixedPort ?? options.defaultPort,
      proxyOrigin: null,
      tailscaleOrigin: null,
      transport: "tailscale",
      trustedProxies: [],
    };
    this.active = options.fixedPort === null ? stored : { ...stored, port: options.fixedPort };
    const pending = this.read<PendingConfig>("pending");
    if (pending) {
      if (pending.boots >= 1) {
        // The previous boot never confirmed this configuration: restore the last good one.
        this.active = this.read<RemoteAccessConfig>("last-good") ?? this.active;
        this.write("active", this.active);
        this.remove("pending");
      } else {
        this.active = pending.config;
        this.write("pending", { ...pending, boots: pending.boots + 1 });
        this.awaiting = { deadline: options.now() + CONFIRMATION_WINDOW, local: pending.local };
      }
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

  listening() {
    return {
      ...this.listener,
      pendingConfirmation: this.awaiting
        ? { deadline: this.awaiting.deadline, local: this.awaiting.local }
        : null,
    };
  }

  policy(): RemoteAccessPolicy {
    const config = this.active;
    return {
      enabled: config.enabled,
      proxiedOrigins: [
        ...(config.transport === "tailscale" && config.tailscaleOrigin
          ? [config.tailscaleOrigin]
          : []),
        ...(config.transport === "proxy" && config.proxyOrigin ? [config.proxyOrigin] : []),
      ],
      trustedProxies: config.transport === "proxy" ? config.trustedProxies : [],
    };
  }

  /**
   * HTTPS addresses of the local network listener: the `.local` name, extra names and IPv4
   * addresses of non-internal interfaces. They are hints for other devices, never trust.
   */
  lanOrigins(config: RemoteAccessConfig) {
    const port = this.servicePort(config);
    const names = [`${hostname().replace(LOCAL_HOST_SUFFIX, "")}.local`, ...config.lanHostnames];
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter(
        (item) => item && !item.internal && item.family === "IPv4" && !item.address.includes("%")
      )
      .map((item) => (item?.family === "IPv6" ? `[${item.address}]` : (item?.address ?? "")));
    return [...new Set([...names, ...addresses])].map((host) => `https://${host}:${port}`);
  }

  /** Loopback port that Tailscale Serve or a local proxy forwards to. */
  servicePort(config: RemoteAccessConfig) {
    return this.options.fixedPort === null ? config.port : (this.listener?.port ?? config.port);
  }

  /** Listener for the active configuration: loopback HTTP unless the local network needs TLS. */
  listenOptions() {
    const config = this.active;
    if (!config.enabled) {
      return { hostname: "127.0.0.1" as const, port: this.options.fixedPort ?? config.port };
    }
    if (config.transport === "lan") {
      const certificate = readFileSync(join(this.options.dataDir, "tls/server.pem"), "utf8");
      const leaf = new X509Certificate(certificate);
      if (
        Date.parse(leaf.validTo) <= this.options.now() ||
        Date.parse(leaf.validFrom) > this.options.now()
      ) {
        throw new Error(
          "The local network certificate is expired or not yet valid. Renew it on the host before starting sharing"
        );
      }
      return {
        hostname: "0.0.0.0" as const,
        port: config.port,
        tls: {
          cert: certificate,
          key: readFileSync(join(this.options.dataDir, "tls/server-key.pem"), "utf8"),
        },
      };
    }
    return { hostname: "127.0.0.1" as const, port: config.port };
  }

  /** Listener the server actually opened; reported once it is ready. */
  ready(listener: ListenerState) {
    this.listener = listener;
    if (!this.awaiting && this.active.port === 0) {
      // An explicitly requested ephemeral port becomes the forwarding target for this listener.
      this.active = { ...this.active, port: listener.port };
      this.write("active", this.active);
      this.write("last-good", this.active);
    }
    if (!this.awaiting) {
      return;
    }
    if (this.awaiting.local) {
      this.confirm();
      return;
    }
    const remaining = Math.max(0, this.awaiting.deadline - this.options.now());
    this.awaiting.timer = setTimeout(() => this.revert(), remaining);
    this.awaiting.timer.unref?.();
  }

  /** Whether the open listener differs from what `config` needs. */
  private needsRebind(config: RemoteAccessConfig) {
    const { listener } = this;
    if (!listener) {
      return false;
    }
    const tls = config.enabled && config.transport === "lan";
    const wildcard = tls;
    return (
      listener.tls !== tls ||
      (listener.hostname !== "127.0.0.1") !== wildcard ||
      // A headless listener keeps the port it was started with (TOFU_PORT).
      (this.options.fixedPort === null && config.enabled && listener.port !== config.port)
    );
  }

  /**
   * Applies a configuration. Changes that keep the listener take effect immediately. Changes that
   * rebind it are journaled, the backend restarts, and the new configuration must be confirmed
   * through the new route within 90 seconds or the previous one is restored.
   */
  apply(config: RemoteAccessConfig, local: boolean) {
    if (this.awaiting) {
      return problem(409, { detail: "Confirm or wait for the previous connection change first" });
    }
    if (!this.needsRebind(config)) {
      this.active = config;
      this.write("active", config);
      this.write("last-good", config);
      return { config, confirmBy: null, restarting: false };
    }
    this.write("last-good", this.active);
    this.write("pending", { boots: 0, config, local } satisfies PendingConfig);
    setTimeout(() => this.options.restart(), 250).unref?.();
    return {
      config,
      confirmBy: local ? null : this.options.now() + CONFIRMATION_WINDOW,
      restarting: true,
    };
  }

  /** Records facts that never rebind the listener, such as a verified Tailscale address. */
  save(config: RemoteAccessConfig) {
    this.active = config;
    this.write("active", config);
    this.write("last-good", config);
    return config;
  }

  /** Offline owner recovery cancels any unfinished change before disabling exposure. */
  disable() {
    clearTimeout(this.awaiting?.timer);
    this.awaiting = null;
    this.remove("pending");
    this.active = { ...this.active, enabled: false };
    this.write("active", this.active);
    this.write("last-good", this.active);
    return this.active;
  }

  confirm() {
    if (!this.awaiting) {
      return problem(409, { detail: "No connection change is waiting for confirmation" });
    }
    clearTimeout(this.awaiting.timer);
    this.awaiting = null;
    this.write("active", this.active);
    this.write("last-good", this.active);
    this.remove("pending");
    return { config: this.active, confirmed: true as const };
  }

  private revert() {
    this.active = this.read<RemoteAccessConfig>("last-good") ?? this.active;
    this.write("active", this.active);
    this.remove("pending");
    this.awaiting = null;
    this.options.restart();
  }
}
