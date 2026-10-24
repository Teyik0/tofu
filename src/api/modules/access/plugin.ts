import "@teyik0/furin/server-only";
import { createContext, Elysia, ElysiaStatus, problem } from "elysia";
import { databasePlugin, instance } from "../../lib/database-plugin";
import { reserveInitialization } from "../../lib/lifecycle-plugin";
import { listen } from "../../lib/network";
import { runtime } from "../../lib/runtime";
import { tailscale } from "../../lib/tailscale";
import { closeLan, openLan } from "../../lib/tailscale/lan";
import { disableTailscale } from "../../lib/tailscale/system";
import { Devices } from "./devices";
import { rank } from "./grants";
import { Invitations } from "./invitations";
import { AccessService, type Caller, callers } from "./service";

using _initialization = reserveInitialization();

type Member = Exclude<Caller, { kind: "anonymous" }>;

function member(request: Request) {
  const caller = callers.get(request);
  if (!caller) {
    return problem(403, { detail: "This endpoint is not available during server rendering" });
  }
  if (caller.kind === "anonymous") {
    return problem(401, { detail: "Sign in to this server" });
  }
  return caller;
}

function atLeast(caller: Member, role: "management" | "administration") {
  return caller.kind === "owner" || rank(caller.device.role) >= rank(role);
}

/**
 * Route-level authorization. Each macro authenticates the caller established by network
 * admission and fails with a literal 401 or 403 that Eden types preserve. Only `playback`
 * admits in-process dispatch, so server rendering can read Playback-safe data and nothing else.
 */
export const accessPlugin = new Elysia({ name: "tofu-access" })
  .use(databasePlugin)
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Restore independent persisted transports before publishing their dependencies.
  .use(async (app) => {
    await using startup = new AsyncDisposableStack();
    startup.defer(tailscale.close);
    const { db, resources } = createContext(app).prototype;
    const access = new AccessService({
      db,
      defaultLanPort: instance.profile === "dev" ? 3442 : 3443,
      headless: () => runtime.current.kind === "server",
      now: Date.now,
    });
    access.listenerPort = listen.port;
    startup.defer(async () => {
      const turn = access.reserve();
      using cleanup = new DisposableStack();
      cleanup.defer(turn.release);
      await turn.previous;
      const closed = await closeLan(access);
      if (closed instanceof ElysiaStatus) {
        throw new Error(closed.response.detail);
      }
    });

    const config = access.sharing;
    if (config.lan.enabled && config.lan.port === listen.port) {
      throw new Error("The local network HTTPS port conflicts with the application listener");
    }
    if (
      config.tailscale.serveOwned &&
      !(config.tailscale.enabled && config.tailscale.mode === "system")
    ) {
      const removed = await disableTailscale(listen.port);
      if (removed.state === "available" || removed.state === "conflict") {
        access.save({ ...config, tailscale: { ...config.tailscale, serveOwned: false } });
      }
    }

    if (config.lan.enabled || (config.tailscale.enabled && config.tailscale.mode === "embedded")) {
      const started = await tailscale.start();
      if (started instanceof ElysiaStatus) {
        throw new Error(started.response.detail);
      }
    }
    if (config.tailscale.enabled && config.tailscale.mode === "embedded") {
      const started = await tailscale.request({
        hostname: `tofu-${access.identity().serverId.slice(0, 8)}`,
        method: "start",
      });
      if (started instanceof ElysiaStatus) {
        throw new Error(started.response.detail);
      }
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: Each native readiness check depends on the previous response.
        const status = await tailscale.request({ method: "serve", port: listen.port });
        if (status instanceof ElysiaStatus) {
          throw new Error(status.response.detail);
        }
        if (status.authUrl) {
          throw new Error("The embedded Tailscale login expired. Reconnect it on the host");
        }
        if (status.origin && status.origin !== config.tailscale.origin) {
          throw new Error("The embedded Tailscale identity changed. Review it on the host");
        }
        if (status.state === "ready" && status.origin === config.tailscale.origin) {
          access.opened("tailscale");
          ready = true;
          break;
        }
        await Bun.sleep(250);
      }
      if (!ready) {
        throw new Error("The embedded private network is not ready");
      }
    }
    if (config.lan.enabled) {
      const opened = await openLan(access, access.sharing, listen.port);
      if (opened instanceof ElysiaStatus) {
        throw new Error(opened.response.detail);
      }
    }

    const devices = new Devices({ access, db, now: Date.now });
    const invitations = new Invitations({ access, db, now: Date.now });
    resources.use(startup.move());
    return app.decorate({ access, devices, invitations });
  })
  .macro({
    administration: {
      derive({ request }) {
        const caller = member(request);
        if (caller instanceof ElysiaStatus) {
          return caller;
        }
        if (!atLeast(caller, "administration")) {
          return problem(403, { detail: "This requires Administration access to this server" });
        }
        return { caller };
      },
    },
    management: {
      derive({ request }) {
        const caller = member(request);
        if (caller instanceof ElysiaStatus) {
          return caller;
        }
        if (!atLeast(caller, "management")) {
          return problem(403, { detail: "This requires Management access to this server" });
        }
        return { caller };
      },
    },
    owner: {
      derive({ request }) {
        const caller = member(request);
        if (caller instanceof ElysiaStatus) {
          return caller;
        }
        if (caller.kind !== "owner") {
          return problem(403, { detail: "Change this on the server itself" });
        }
        return { caller };
      },
    },
    personal: {
      derive({ request }) {
        const caller = member(request);
        if (caller instanceof ElysiaStatus) {
          return caller;
        }
        return { caller };
      },
    },
    playback: {
      derive({ request }) {
        const caller = callers.get(request);
        if (caller?.kind === "anonymous") {
          return problem(401, { detail: "Sign in to this server" });
        }
        return { caller: caller ?? ({ kind: "in-process" } as const) };
      },
    },
    public: {
      derive({ request }) {
        return { caller: callers.get(request) ?? ({ kind: "in-process" } as const) };
      },
    },
  });

await accessPlugin.modules;
