import { Context, Effect, Layer } from "effect";
import { ElysiaStatus } from "elysia";
import { instance } from "../../lib/instance";
import { tailscale } from "../../lib/tailscale/index";
import { closeLan, openLan } from "../../lib/tailscale/lan";
import { disableTailscale } from "../../lib/tailscale/system";
import { AuthorizedDevices, authorizedDevicesLayer } from "./devices";
import { PairingInvitations, pairingInvitationsLayer } from "./invitations";
import { AccessControl, accessControlLayer } from "./service";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Restore independent persisted transports before publishing their dependencies.
const make = Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.promise(tailscale.close));
  const access = yield* Effect.acquireRelease(AccessControl, (service) =>
    Effect.gen(function* () {
      const turn = service.reserve();
      yield* Effect.acquireRelease(Effect.succeed(turn), (reservation) =>
        Effect.sync(reservation.release)
      );
      yield* Effect.promise(() => turn.previous);
      const closed = yield* Effect.promise(() => closeLan(service));
      if (closed instanceof ElysiaStatus) {
        yield* Effect.die(new Error(closed.response.detail));
      }
    }).pipe(Effect.scoped)
  );
  access.setListenerPort(instance.port);
  const config = access.sharing();
  if (config.lan.enabled && config.lan.port === instance.port) {
    return yield* Effect.fail(
      new Error("The local network HTTPS port conflicts with the application instance")
    );
  }
  if (
    config.tailscale.serveOwned &&
    !(config.tailscale.enabled && config.tailscale.mode === "system")
  ) {
    const removed = yield* Effect.tryPromise(() => disableTailscale(instance.port));
    if (removed.state === "available" || removed.state === "conflict") {
      access.save({ ...config, tailscale: { ...config.tailscale, serveOwned: false } });
    }
  }
  if (config.lan.enabled || (config.tailscale.enabled && config.tailscale.mode === "embedded")) {
    const started = yield* Effect.tryPromise(() => tailscale.start());
    if (started instanceof ElysiaStatus) {
      return yield* Effect.fail(new Error(started.response.detail));
    }
  }
  if (config.tailscale.enabled && config.tailscale.mode === "embedded") {
    const started = yield* Effect.tryPromise(() =>
      tailscale.request({
        hostname: `tofu-${access.identity().serverId.slice(0, 8)}`,
        method: "start",
      })
    );
    if (started instanceof ElysiaStatus) {
      return yield* Effect.fail(new Error(started.response.detail));
    }
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const status = yield* Effect.tryPromise(() =>
        tailscale.request({ method: "serve", port: instance.port })
      );
      if (status instanceof ElysiaStatus) {
        return yield* Effect.fail(new Error(status.response.detail));
      }
      if (status.authUrl) {
        return yield* Effect.fail(
          new Error("The embedded Tailscale login expired. Reconnect it on the host")
        );
      }
      if (status.origin && status.origin !== config.tailscale.origin) {
        return yield* Effect.fail(
          new Error("The embedded Tailscale identity changed. Review it on the host")
        );
      }
      if (status.state === "ready" && status.origin === config.tailscale.origin) {
        access.opened("tailscale");
        ready = true;
        break;
      }
      yield* Effect.sleep("250 millis");
    }
    if (!ready) {
      return yield* Effect.fail(new Error("The embedded private network is not ready"));
    }
  }
  if (config.lan.enabled) {
    const opened = yield* Effect.tryPromise(() => openLan(access, access.sharing(), instance.port));
    if (opened instanceof ElysiaStatus) {
      return yield* Effect.fail(new Error(opened.response.detail));
    }
  }
  return {
    access,
    devices: yield* AuthorizedDevices,
    invitations: yield* PairingInvitations,
  };
});

export class Access extends Context.Service<Access, Effect.Success<typeof make>>()("tofu/access") {}

export const accessLayer = Layer.effect(Access, make).pipe(
  Layer.provideMerge(
    Layer.mergeAll(authorizedDevicesLayer, pairingInvitationsLayer).pipe(
      Layer.provideMerge(accessControlLayer)
    )
  )
);
