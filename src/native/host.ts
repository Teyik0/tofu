import { dirname, join } from "node:path";
import type { DesktopConfig } from "@teyik0/furin-electrobun";
import {
  type DesktopBackend,
  type DesktopCapabilities,
  getDesktopDevelopment,
  type NativeActionContext,
  type OpenEvent,
  type ReadyContext,
} from "@teyik0/furin-electrobun/host";
// biome-ignore lint/performance/noNamespaceImport: Native server windows share the canonical SDK namespace.
import * as sdk from "electrobun/main";
import { type SavedServer, ServerCatalog } from "./catalog";
import { nativeControl } from "./control";
import { discoverLocalServers } from "./discovery";
import type { NativeServerAction } from "./model";
import { RemoteThreads } from "./remote-threads";

const WHITESPACE = /\s+/;
const CREDENTIAL_FAILURE = /identity|revoked|expired|Incompatible|cookie/;
const SERVER_ID = /^[a-f0-9-]{36}$/;

// Furin loads this native customization before the backend, after resolving its data directory.
const identity = await sdk.Updater.getLocalInfo();
const development = await getDesktopDevelopment();
const config: DesktopConfig =
  development?.config ?? (await Bun.file(join(dirname(Bun.main), "furin-host.json")).json());
const dataDir = process.env.FURIN_APP_DATA_DIR;
if (!dataDir) {
  throw new Error("The native customization requires Furin's resolved data directory");
}
const catalog = new ServerCatalog(join(dataDir, "native"));
await catalog.read();
const service = `app.tofu.torrents.servers${identity.channel === "dev" ? ".dev" : ""}`;
const memory = new Map<string, string>();
const windows = new Map<
  string,
  {
    window: InstanceType<typeof sdk.BrowserWindow>;
    view: InstanceType<typeof sdk.BrowserView>;
    path: string;
  }
>();
const statuses = new Map<string, string>();
const opening = new Set<string>();
let desktop: DesktopCapabilities;
let backend: DesktopBackend | undefined;
let serverAction = Promise.resolve();
let message = "";
let discovered: Awaited<ReturnType<typeof discoverLocalServers>>["servers"] = [];
const pendingOAuth = new Map<
  string,
  { serverId: string; deviceId: string; origin: string; expiresAt: number }
>();
const pairing = new Map<string, { nonce: string; at: number }>();

function nativeOrigin(value: string) {
  const url = URL.parse(value.includes("://") ? value : `https://${value}`);
  if (
    !url ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("Enter an HTTPS server address. Plain HTTP is allowed only for a local tunnel");
  }
  return url.origin;
}

async function descriptor(origin: string, expected: string | null) {
  const response = await fetch(`${origin}/.well-known/tofu`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error("This address is not a Tofu server");
  }
  const body = (await response.json()) as {
    product: string;
    serverId: string;
    name: string;
    protocol: { major: number; minClient: number; maxClient: number };
  };
  if (body.product !== "tofu" || !SERVER_ID.test(body.serverId) || typeof body.name !== "string") {
    throw new Error("This address is not a Tofu server");
  }
  if (expected && body.serverId !== expected) {
    throw new Error(
      "Server identity changed. No credential was sent. Check the address on the host"
    );
  }
  if (
    body.protocol.major !== 1 ||
    !(body.protocol.minClient <= 1 && body.protocol.maxClient >= 1)
  ) {
    throw new Error("Incompatible Tofu version. Update this application or the server");
  }
  return body;
}

async function credential(server: SavedServer) {
  if (server.temporary) {
    return memory.get(server.serverId) ?? null;
  }
  try {
    return await Bun.secrets.get({ name: `${server.serverId}/${server.deviceId}`, service });
  } catch (cause) {
    throw new Error(
      "The OS credential store is unavailable or locked. Unlock it or pair with a memory-only connection",
      { cause }
    );
  }
}

async function authorized(origin: string, token: string, path: string, body?: object) {
  const response = await fetch(`${origin}${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Access expired or was revoked. Ask the server owner for a new invitation");
    }
    throw new Error("The server could not complete this request. Try again");
  }
  return response;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Trusted native commands validate and act in one auditable capability boundary.
async function openSaved(server: SavedServer, resumePath?: string) {
  if (opening.has(server.serverId)) {
    return;
  }
  const existing = windows.get(server.serverId);
  if (existing) {
    existing.window.show();
    existing.window.activate();
    return;
  }
  opening.add(server.serverId);
  statuses.set(server.serverId, "Connecting");
  let failure = "The server is offline. Check its address and network connection";
  try {
    const token = await credential(server);
    if (!token) {
      throw new Error("This connection has no saved credential. Pair it again");
    }
    for (const origin of server.origins) {
      try {
        // Probe public identity before sending any credential to this address.
        // biome-ignore lint/performance/noAwaitInLoops: Routes are tried in saved order only after failure.
        await descriptor(origin, server.serverId);
        const response = await authorized(origin, token, "/api/auth/window-sessions", {});
        const cookie = (await response.json()) as {
          cookie: string;
          value: string;
          expiresAt: number;
        };
        if (!(cookie.cookie && cookie.value)) {
          throw new Error("This server did not issue a window session");
        }
        const partition = `persist:srv-${server.serverId}-${server.deviceId}`;
        const session = sdk.Session.fromPartition(partition);
        if (
          !session.cookies.set({
            domain: new URL(origin).hostname,
            expirationDate: cookie.expiresAt / 1000,
            httpOnly: true,
            name: cookie.cookie,
            path: "/",
            sameSite: "strict",
            secure: origin.startsWith("https:"),
            value: cookie.value,
          })
        ) {
          throw new Error("The native cookie store could not install this window session");
        }
        const installed = session.cookies
          .get({ name: cookie.cookie })
          .find((item) => item.value === cookie.value);
        if (
          !(
            installed?.httpOnly &&
            installed.secure === origin.startsWith("https:") &&
            installed.domain === new URL(origin).hostname &&
            installed.path === "/" &&
            installed.sameSite?.toLowerCase() === "strict"
          )
        ) {
          session.cookies.remove(origin, cookie.cookie);
          throw new Error(
            "This native SDK cannot protect window cookies (HttpOnly, host-only, Secure and SameSite). Use a browser with its own invitation until the SDK is fixed."
          );
        }
        const window = new sdk.BrowserWindow({
          allowedProtocols: { appData: false, views: false },
          frame: config.window,
          navigationRules: JSON.stringify(["^*"]),
          sandbox: true,
          title: `${server.alias || server.name} · Tofu`,
          url: "about:blank",
        });
        const view = new sdk.BrowserView({
          allowedProtocols: { appData: false, views: false },
          autoResize: true,
          frame: { height: config.window.height, width: config.window.width, x: 0, y: 0 },
          navigationRules: JSON.stringify(["^*", `${origin}/*`]),
          partition,
          sandbox: true,
          url: `${origin}${resumePath ?? "/"}`,
          windowId: window.id,
        });
        const newWindowEvent = `new-window-open-${view.id}`;
        const external = (event: unknown) => {
          const target = eventURL(event);
          if (
            target?.origin === origin &&
            !target.pathname.startsWith("/api/") &&
            !target.pathname.startsWith("/auth/")
          ) {
            const current = windows.get(server.serverId);
            if (current?.view === view) {
              current.path = `${target.pathname}${target.search}`;
            }
          }
          if (
            target?.origin !== "https://anilist.co" ||
            target.pathname !== "/api/v2/oauth/authorize" ||
            !target.searchParams.get("state")
          ) {
            return;
          }
          const openAuthorization = async () => {
            const choice = await sdk.Utils.showMessageBox({
              buttons: ["Cancel", "Open AniList"],
              cancelId: 0,
              defaultId: 0,
              detail:
                "The account is saved on this server. This does not connect another server's AniList account.",
              message: `Open AniList sign-in for ${server.alias || server.name}?`,
              title: "Connect AniList",
              type: "question",
            });
            if (choice.response !== 1) {
              return;
            }
            const state = target.searchParams.get("state");
            if (state) {
              pendingOAuth.set(state, {
                deviceId: server.deviceId,
                expiresAt: Date.now() + 600_000,
                origin,
                serverId: server.serverId,
              });
            }
            sdk.Utils.openExternal(target.href);
          };
          void openAuthorization();
        };
        sdk.default.events.on(newWindowEvent, external);
        view.on("will-navigate", external);
        if (process.env.TOFU_NATIVE_REMOTE_TEST_SCRIPT) {
          const script = await Bun.file(process.env.TOFU_NATIVE_REMOTE_TEST_SCRIPT).text();
          view.on("dom-ready", () => view.executeJavascript(script));
        }
        window.on("close", () => {
          sdk.default.events.off(newWindowEvent, external);
          view.remove();
          if (windows.get(server.serverId)?.window === window) {
            windows.delete(server.serverId);
            statuses.set(server.serverId, "Disconnected");
          }
        });
        windows.set(server.serverId, { path: resumePath ?? "/", view, window });
        statuses.set(server.serverId, "Connected");
        return;
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : failure;
        if (CREDENTIAL_FAILURE.test(failure)) {
          break;
        }
      }
    }
    throw new Error(failure);
  } catch (cause) {
    statuses.set(server.serverId, cause instanceof Error ? cause.message : failure);
    throw cause;
  } finally {
    opening.delete(server.serverId);
  }
}

function eventURL(event: unknown) {
  if (
    !event ||
    typeof event !== "object" ||
    !("data" in event) ||
    !event.data ||
    typeof event.data !== "object" ||
    !("detail" in event.data)
  ) {
    return null;
  }
  const { detail } = event.data;
  let value: unknown = detail;
  if (typeof detail === "string" && detail.startsWith("{")) {
    try {
      value = JSON.parse(detail);
    } catch {
      return null;
    }
  }
  let address: unknown = value;
  if (value && typeof value === "object" && "url" in value) {
    address = value.url;
  }
  return typeof address === "string" ? URL.parse(address) : null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Trusted native commands validate and act in one auditable capability boundary.
async function command(
  action: string,
  input: {
    id?: string;
    alias?: string;
    origins?: string;
    address?: string;
    code?: string;
    label?: string;
    temporary?: boolean;
  }
) {
  if (action === "discover") {
    message = "Looking for Tofu servers on this network…";
    const result = await discoverLocalServers();
    discovered = result.servers;
    message = result.detail;
    return;
  }
  const server = catalog.value.servers.find((candidate) => candidate.serverId === input.id);
  if (action === "pair") {
    if (!(input.address && input.label)) {
      throw new Error("Enter the server address and this device's name");
    }
    const origin = nativeOrigin(input.address);
    const info = await descriptor(origin, null);
    if (catalog.value.servers.some((candidate) => candidate.serverId === info.serverId)) {
      throw new Error("This server is already saved. Edit its addresses in Details");
    }
    const secret =
      new URLSearchParams(URL.parse(input.address)?.hash.slice(1) ?? "").get("i") ?? undefined;
    const attemptKey = `${origin}:${secret ?? input.code}`;
    let attempt = pairing.get(attemptKey);
    if (!attempt || Date.now() - attempt.at > 120_000) {
      attempt = { at: Date.now(), nonce: crypto.randomUUID() };
      pairing.set(attemptKey, attempt);
    }
    const response = await fetch(`${origin}/api/auth/pair`, {
      body: JSON.stringify({
        code: input.code || undefined,
        kind: "desktop",
        label: input.label.slice(0, 64),
        nonce: attempt.nonce,
        secret: secret || undefined,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const paired = (await response.json()) as {
      detail?: string;
      device: { id: string };
      server: { id: string };
      token?: string;
    };
    if (!response.ok) {
      throw new Error(paired.detail ?? "This invitation was refused");
    }
    if (!paired.token || paired.server.id !== info.serverId) {
      throw new Error("The server identity changed during pairing");
    }
    const saved: SavedServer = {
      alias: "",
      deviceId: paired.device.id,
      name: info.name,
      origins: [origin],
      serverId: info.serverId,
      temporary: input.temporary === true,
    };
    if (saved.temporary) {
      memory.set(saved.serverId, paired.token);
    } else {
      try {
        const options = {
          name: `${saved.serverId}/${saved.deviceId}`,
          persist: "local" as const,
          service,
          value: paired.token,
        };
        await Bun.secrets.set(options);
      } catch (cause) {
        throw new Error(
          "The OS credential store is unavailable. Select ‘Keep this connection until Tofu quits’ and retry the same invitation",
          { cause }
        );
      }
    }
    catalog.value.servers.push(saved);
    await catalog.save();
    pairing.delete(attemptKey);
    nativeControl.tofuNativeThreads?.start(saved.serverId);
    message = `Connected to ${saved.name}.`;
    await openSaved(saved);
    return;
  }
  if (server && action === "reconnect") {
    await nativeControl.tofuNativeThreads?.stop(server.serverId);
    nativeControl.tofuNativeThreads?.start(server.serverId);
    const current = windows.get(server.serverId);
    const path = current?.path;
    current?.window.close();
    windows.delete(server.serverId);
    await openSaved(server, path);
  } else if (server && action === "open") {
    nativeControl.tofuNativeThreads?.start(server.serverId);
    await openSaved(server);
  } else if (server && action === "disconnect") {
    await nativeControl.tofuNativeThreads?.stop(server.serverId);
    windows.get(server.serverId)?.window.close();
    statuses.set(server.serverId, "Disconnected");
  } else if (server && action === "save-server") {
    const origins = [
      ...new Set((input.origins ?? "").split(WHITESPACE).filter(Boolean).map(nativeOrigin)),
    ];
    if (!origins.length || origins.length > 4) {
      throw new Error("Enter between one and four HTTPS addresses");
    }
    await Promise.all(origins.map((origin) => descriptor(origin, server.serverId)));
    await nativeControl.tofuNativeThreads?.stop(server.serverId);
    server.origins = origins;
    server.alias = (input.alias ?? "").trim().slice(0, 64);
    await catalog.save();
    message = "Server details saved on this computer.";
    nativeControl.tofuNativeThreads?.start(server.serverId);
  } else if (server && action === "forget") {
    await nativeControl.tofuNativeThreads?.stop(server.serverId);
    let revoked = false;
    try {
      const token = await credential(server);
      const [origin] = server.origins;
      if (token && origin) {
        await descriptor(origin, server.serverId);
        await authorized(origin, token, "/api/auth/logout", {});
        revoked = true;
      }
    } catch {
      revoked = false;
    }
    windows.get(server.serverId)?.window.close();
    const session = sdk.Session.fromPartition(`persist:srv-${server.serverId}-${server.deviceId}`);
    session.clearStorageData("all");
    session.cookies.clear();
    if (!server.temporary) {
      await Bun.secrets.delete({ name: `${server.serverId}/${server.deviceId}`, service });
    }
    memory.delete(server.serverId);
    catalog.value.servers = catalog.value.servers.filter(
      (item) => item.serverId !== server.serverId
    );
    await catalog.save();
    message = revoked
      ? "Server forgotten and its device session revoked."
      : "Removed here. Its session could not be revoked; revoke it on the server.";
  }
}

export function nativeServerSnapshot() {
  return {
    discovered: discovered.map((server) => ({ ...server })),
    local: !!backend,
    message,
    servers: catalog.value.servers.map((server) => ({
      ...server,
      origins: [...server.origins],
      status: statuses.get(server.serverId) ?? "Saved",
    })),
  };
}

/** Serializes requests at the native boundary; SDK/keyring/network failures stay ordinary data. */
export async function runNativeServerAction(input: NativeServerAction) {
  const previous = serverAction;
  const reservation = Promise.withResolvers<void>();
  serverAction = reservation.promise;
  try {
    await previous;
    message = "";
    await command(input.action, input);
    return { ok: true as const, state: nativeServerSnapshot() };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "Unable to change the desktop server";
    message = detail;
    return { detail, ok: false as const };
  } finally {
    reservation.resolve();
  }
}

/** Selects the trusted local view by its backend/bootstrap origin, never a remote document. */
function openConnections(invitation?: string) {
  if (!backend) {
    return;
  }
  desktop.window.open();
  const localView = sdk.BrowserView.getAll().find((view) => {
    const origin = view.url ? URL.parse(view.url)?.origin : undefined;
    return origin === backend?.origin || (!!origin && origin === backend?.bootstrapOrigin);
  });
  if (localView) {
    const destination = new URL("/options/connections", backend.origin);
    if (invitation) {
      destination.hash = new URLSearchParams({ invitation }).toString();
    }
    localView.loadURL(backend.createWindowUrl(`${destination.pathname}${destination.hash}`));
  }
}

nativeControl.tofuNativeThreads = new RemoteThreads({
  catalog,
  memory,
  service,
});

nativeControl.tofuNativeServers = { read: nativeServerSnapshot, run: runNativeServerAction };

export const nativeHost = {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Trusted native commands validate and act in one auditable capability boundary.
  async onOpen({ event }: NativeActionContext & { event: OpenEvent }) {
    if (event.type !== "url") {
      return false;
    }
    const url = URL.parse(event.url);
    if (
      url &&
      ["tofu:", "tofu-dev:"].includes(url.protocol) &&
      url.hostname === "oauth" &&
      url.pathname === "/anilist"
    ) {
      const state = new URLSearchParams(url.hash.slice(1)).get("state");
      const pending = state ? pendingOAuth.get(state) : undefined;
      if (!pending) {
        return false;
      }
      pendingOAuth.delete(state as string);
      const server = catalog.value.servers.find(
        (item) => item.serverId === pending.serverId && item.deviceId === pending.deviceId
      );
      if (!server || pending.expiresAt < Date.now()) {
        message = "AniList sign-in expired. Start it again from the server.";
        openConnections();
        return true;
      }
      try {
        await descriptor(pending.origin, server.serverId);
        const token = await credential(server);
        if (!token) {
          throw new Error("This connection has no credential");
        }
        await authorized(pending.origin, token, "/api/anilist/oauth/remote-callback", {
          url: event.url,
        });
        message = `AniList connected on ${server.name}.`;
      } catch (cause) {
        message = cause instanceof Error ? cause.message : "Unable to connect AniList";
      }
      openConnections();
      return true;
    }
    if (url && ["tofu:", "tofu-dev:"].includes(url.protocol) && url.hostname === "pair") {
      const address = url.searchParams.get("server");
      const invitation = address ? `${nativeOrigin(address)}/pair${url.hash}` : undefined;
      openConnections(invitation);
      return true;
    }
    return false;
  },
  onReady(context: ReadyContext) {
    if (context.runtime.kind === "desktop") {
      ({ desktop } = context.runtime);
      // The native host supplies the full backend, including single-use window bootstrap URLs.
      backend = context.backend as DesktopBackend;
    }
  },
  openConnections,
};

nativeControl.tofuNativeHost = nativeHost;
