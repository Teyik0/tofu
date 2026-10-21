import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopConfig } from "@teyik0/furin-electrobun";
import type { DesktopBackend, DesktopCapabilities } from "@teyik0/furin-electrobun/host";
import {
  getDesktopDevelopment,
  resolveDesktopDataDir,
  runStandardDesktopHost,
} from "@teyik0/furin-electrobun/host";
// biome-ignore lint/performance/noNamespaceImport: The SDK namespace is passed to the standard native host as required by its API.
import * as sdk from "electrobun/main";
import { type SavedServer, ServerCatalog } from "./catalog";
import { nativeControl } from "./control";
import { discoverLocalServers } from "./discovery";
import { managerDocument } from "./manager-document";
import type { NativeServerAction } from "./model";

const WHITESPACE = /\s+/;
const CREDENTIAL_FAILURE = /identity|revoked|expired|Incompatible|cookie/;
const SERVER_ID = /^[a-f0-9-]{36}$/;

// This entry has no static backend/database/worker import. The standard host alone owns loading it.
const identity = await sdk.Updater.getLocalInfo();
const development = await getDesktopDevelopment();
const config: DesktopConfig =
  development?.config ?? (await Bun.file(join(dirname(Bun.main), "furin-host.json")).json());
const root = development?.root ?? dirname(Bun.main);
const dataDir =
  typeof config.dataDir === "string"
    ? config.dataDir
    : await resolveDesktopDataDir(config.dataDir ?? { developmentName: "Tofu-dev", name: "Tofu" }, {
        channel: identity.channel,
        mode: development ? "dev" : "build",
        root,
      });
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
let manager: InstanceType<typeof sdk.BrowserWindow> | null = null;
let desktop: DesktopCapabilities;
let backend: DesktopBackend | undefined;
let managerInitialized = false;
let serverAction = Promise.resolve();
let message = "";
let discovered: Awaited<ReturnType<typeof discoverLocalServers>>["servers"] = [];
let details: { serverId: string; alias: string; origins: string[] } | null = null;
const proofScript = process.env.TOFU_NATIVE_MANAGER_TEST_SCRIPT
  ? await Bun.file(process.env.TOFU_NATIVE_MANAGER_TEST_SCRIPT).text()
  : null;
const managerNonce = crypto.randomUUID();
const transferQueue: {
  id: string;
  name: string;
  event: { type: "file"; path: string } | { type: "url"; url: string };
  serverId?: string;
  destinations?: { id: string; name: string }[];
}[] = [];
const transferCookies = new Map<string, { origin: string; cookie: string }>();
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

function render() {
  manager?.webview.executeJavascript(
    `window.renderManager?.(${JSON.stringify({ details, discovered, local: !!backend, message, servers: catalog.value.servers.map((server) => ({ ...server, status: statuses.get(server.serverId) ?? "Saved" })), transfer: transferQueue[0] ? { destinations: transferQueue[0].destinations, id: transferQueue[0].id, name: transferQueue[0].name, serverId: transferQueue[0].serverId } : null })})`
  );
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
  render();
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
        const nonce = crypto.randomUUID();
        const window = new sdk.BrowserWindow({
          allowedProtocols: { appData: false, views: false },
          frame: config.window,
          html: managerDocument(nonce, true),
          navigationRules: JSON.stringify(["^*"]),
          sandbox: true,
          title: `${server.alias || server.name} · Tofu`,
        });
        window.webview.on("dom-ready", () =>
          window.webview.executeJavascript(
            `window.renderManager?.(${JSON.stringify({ name: server.alias || server.name, status: "Connected" })})`
          )
        );
        window.webview.on("will-navigate", (event) => {
          const url = eventURL(event);
          if (
            url?.protocol === "tofu-manager:" &&
            url.hostname === "manager" &&
            url.searchParams.get("nonce") === nonce
          ) {
            openConnections();
          }
        });
        const view = new sdk.BrowserView({
          allowedProtocols: { appData: false, views: false },
          autoResize: true,
          frame: { height: config.window.height - 56, width: config.window.width, x: 0, y: 56 },
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
            render();
          }
        });
        windows.set(server.serverId, { path: resumePath ?? "/", view, window });
        statuses.set(server.serverId, "Connected");
        render();
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
    render();
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
    serverId?: string;
    destinationId?: string;
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
    render();
    const result = await discoverLocalServers();
    discovered = result.servers;
    message = result.detail;
    render();
    return;
  }
  if (action === "proof" && process.env.TOFU_NATIVE_MANAGER_TEST_REPORT && proofScript) {
    await Bun.write(
      process.env.TOFU_NATIVE_MANAGER_TEST_REPORT,
      JSON.stringify({
        backend: !!backend,
        databaseCreated: await Bun.file(join(dataDir, "feeds.sqlite")).exists(),
        input,
        runtime: Bun.version,
        views: sdk.BrowserView.getAll().map((view) => ({
          partition: view.partition,
          sandbox: view.sandbox,
          url: view.url,
        })),
      })
    );
    await desktop.quit();
    return;
  }
  const server = catalog.value.servers.find((candidate) => candidate.serverId === input.id);
  if (action === "transfer-target") {
    const [transfer] = transferQueue;
    if (!transfer || transfer.id !== input.id) {
      throw new Error("This file is no longer waiting");
    }
    const targetId = input.serverId ?? "local";
    let origin: string;
    let cookie: string;
    if (targetId === "local" && backend) {
      ({ origin, cookie } = backend);
    } else {
      const target = catalog.value.servers.find((candidate) => candidate.serverId === targetId);
      if (!target) {
        throw new Error("Choose a saved server");
      }
      origin = target.origins[0] as string;
      await descriptor(origin, target.serverId);
      const token = await credential(target);
      if (!token) {
        throw new Error("Pair this server again");
      }
      const own = await authorized(origin, token, "/api/session");
      const grants = (await own.json()) as { capabilities: { manage: boolean } };
      if (!grants.capabilities.manage) {
        throw new Error("Adding a torrent requires Management access on this server");
      }
      const issued = await authorized(origin, token, "/api/auth/window-sessions", {});
      const windowSession = (await issued.json()) as { cookie: string; value: string };
      cookie = `${windowSession.cookie}=${windowSession.value}`;
    }
    const state = await fetch(`${origin}/api/state?detail=false`, {
      headers: { cookie, origin },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!state.ok) {
      throw new Error("Unable to read the selected server's threads");
    }
    const library = (await state.json()) as { destinations: { id: string; name: string }[] };
    transfer.serverId = targetId;
    transfer.destinations = library.destinations;
    transferCookies.set(transfer.id, { cookie, origin });
    render();
    return;
  }
  if (action === "transfer-add") {
    const [transfer] = transferQueue;
    const context = transfer ? transferCookies.get(transfer.id) : null;
    if (
      !transfer ||
      transfer.id !== input.id ||
      !context ||
      !transfer.destinations?.some((item) => item.id === input.destinationId)
    ) {
      throw new Error("Choose a server and a thread first");
    }
    if (transfer.serverId !== "local") {
      const target = catalog.value.servers.find((item) => item.serverId === transfer.serverId);
      if (!target) {
        throw new Error("This server was forgotten");
      }
      await descriptor(context.origin, target.serverId);
    }
    let body: FormData | string;
    let path: string;
    if (transfer.event.type === "file") {
      const file = Bun.file(transfer.event.path);
      if (!transfer.event.path.toLowerCase().endsWith(".torrent") || file.size > 8_388_608) {
        throw new Error("Choose a .torrent file under 8 MiB");
      }
      body = new FormData();
      body.set("file", new File([await file.bytes()], transfer.name));
      body.set("paused", "false");
      body.set("destinationId", input.destinationId as string);
      path = "/api/torrents/file";
    } else {
      body = JSON.stringify({
        destinationId: input.destinationId,
        paused: false,
        source: transfer.event.url,
      });
      path = "/api/torrents";
    }
    const response = await fetch(`${context.origin}${path}`, {
      body,
      headers: {
        cookie: context.cookie,
        "idempotency-key": transfer.id,
        origin: context.origin,
        ...(typeof body === "string" ? { "content-type": "application/json" } : {}),
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const failure = (await response.json()) as { detail?: string };
      throw new Error(failure.detail ?? "The selected server refused this torrent");
    }
    transferCookies.delete(transfer.id);
    transferQueue.shift();
    message = `Torrent added to ${transfer.serverId === "local" ? "this computer" : catalog.value.servers.find((item) => item.serverId === transfer.serverId)?.name}.`;
    render();
    return;
  }
  if (action === "transfer-cancel") {
    const transfer = transferQueue.shift();
    if (transfer) {
      transferCookies.delete(transfer.id);
    }
    render();
    return;
  }
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
    message = `Connected to ${saved.name}.`;
    render();
    await openSaved(saved);
    return;
  }
  if (action === "local") {
    if (!backend) {
      throw new Error("The local server is off. Change startup to enable it");
    }
    desktop.window.open();
  } else if (action === "hosting") {
    catalog.value.startLocal = !catalog.value.startLocal;
    await catalog.save();
    await desktop.restart();
  } else if (action === "quit") {
    await desktop.quit();
  } else if (action === "updates") {
    const update = await desktop.updates.check();
    message = update.updateAvailable
      ? `Version ${update.version} is available. Install it from the host's Updates page.`
      : "This application is up to date.";
    render();
  } else if (server && action === "reconnect") {
    const current = windows.get(server.serverId);
    const path = current?.path;
    current?.window.close();
    windows.delete(server.serverId);
    await openSaved(server, path);
  } else if (server && action === "open") {
    await openSaved(server);
  } else if (server && action === "disconnect") {
    windows.get(server.serverId)?.window.close();
    statuses.set(server.serverId, "Disconnected");
    render();
  } else if (server && action === "save-server") {
    const origins = [
      ...new Set((input.origins ?? "").split(WHITESPACE).filter(Boolean).map(nativeOrigin)),
    ];
    if (!origins.length || origins.length > 4) {
      throw new Error("Enter between one and four HTTPS addresses");
    }
    await Promise.all(origins.map((origin) => descriptor(origin, server.serverId)));
    server.origins = origins;
    server.alias = (input.alias ?? "").trim().slice(0, 64);
    await catalog.save();
    details = null;
    message = "Server details saved on this computer.";
    render();
  } else if (server && action === "edit") {
    details = { alias: server.alias, origins: server.origins, serverId: server.serverId };
    render();
  } else if (server && action === "forget") {
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
    render();
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
    startLocal: catalog.value.startLocal,
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
    render();
    return { detail, ok: false as const };
  } finally {
    reservation.resolve();
  }
}

/** Selects the trusted local view by its backend/bootstrap origin, never a remote document. */
function openConnections() {
  if (!backend) {
    showManager();
    return;
  }
  desktop.window.open();
  const localView = sdk.BrowserView.getAll().find((view) => {
    const origin = view.url ? URL.parse(view.url)?.origin : undefined;
    return origin === backend?.origin || (!!origin && origin === backend?.bootstrapOrigin);
  });
  if (localView) {
    localView.loadURL(backend.createWindowUrl("/options/connections"));
  } else {
    showManager();
  }
}

function showManager() {
  if (manager) {
    manager.show();
    manager.activate();
    render();
    return;
  }
  const window = new sdk.BrowserWindow({
    allowedProtocols: { appData: false, views: false },
    frame: { height: 850, width: 900 },
    html: managerDocument(managerNonce, false),
    navigationRules: JSON.stringify(["^*"]),
    sandbox: true,
    title: "Servers · Tofu",
  });
  manager = window;
  window.webview.on("will-navigate", (event) => {
    const url = eventURL(event);
    if (url?.protocol !== "tofu-manager:" || url.searchParams.get("nonce") !== managerNonce) {
      return;
    }
    if (url.hostname === "ready") {
      render();
      if (proofScript) {
        window.webview.executeJavascript(proofScript);
      }
      return;
    }
    const run = async () => {
      let id: string | undefined;
      try {
        const input = JSON.parse(url.searchParams.get("data") ?? "{}");
        ({ id } = input);
        await command(url.hostname, input);
      } catch (cause) {
        message = cause instanceof Error ? cause.message : "The action could not be completed";
        if (id) {
          statuses.set(id, message);
        }
        render();
      }
    };
    void run();
  });
  window.on("close", () => {
    manager = null;
  });
}

nativeControl.tofuNativeServers = { read: nativeServerSnapshot, run: runNativeServerAction };

await runStandardDesktopHost(sdk, {
  config,
  dataDir,
  load: () =>
    import(
      pathToFileURL(development?.serverEntry ?? join(dirname(Bun.main), "../furin/app.js")).href
    ),
  manager(context) {
    ({ desktop, backend } = context);
    const initial = !managerInitialized;
    managerInitialized = true;
    if (context.startupError) {
      message = `Local server failed: ${context.startupError}. Remote servers remain available.`;
    }
    if (!backend || context.startupError) {
      showManager();
    } else if (!initial) {
      openConnections();
    }
  },
  mode: development ? "dev" : "build",
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Trusted native commands validate and act in one auditable capability boundary.
  async onOpen({ event }) {
    if (
      event.type === "file" ||
      (event.type === "url" && URL.parse(event.url)?.protocol === "magnet:")
    ) {
      if (transferQueue.length >= 16) {
        message = "Finish or dismiss waiting torrents before opening more.";
        showManager();
        return true;
      }
      transferQueue.push({
        event,
        id: crypto.randomUUID(),
        name:
          event.type === "file"
            ? basename(event.path)
            : (new URL(event.url).searchParams.get("dn") ?? "Magnet link"),
      });
      showManager();
      return true;
    }
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
        showManager();
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
      showManager();
      return true;
    }
    if (url && ["tofu:", "tofu-dev:"].includes(url.protocol) && url.hostname === "pair") {
      showManager();
      const address = url.searchParams.get("server");
      const invitation = address ? `${nativeOrigin(address)}/pair${url.hash}` : null;
      if (invitation) {
        manager?.webview.executeJavascript(
          `document.querySelector('[name="address"]').value=${JSON.stringify(invitation)}`
        );
      }
      return true;
    }
    return false;
  },
  root,
  startServer: catalog.value.startLocal,
  testScript: process.env.FURIN_NATIVE_TEST_SCRIPT
    ? await Bun.file(process.env.FURIN_NATIVE_TEST_SCRIPT).text()
    : undefined,
});
