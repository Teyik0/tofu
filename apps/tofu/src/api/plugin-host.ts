import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createAniListPlugin } from "@tofu/anilist";
import { createAniListApi } from "@tofu/anilist/api";
import type { PluginAuthDefinition } from "@tofu/plugins";
import {
  createApiKeyAuth,
  createCore,
  createCredentialStore,
  createOAuth2Auth,
  createPluginRuntime,
  type ErasedPluginDefinition,
  type OAuth2Auth,
  type PluginAuth,
  type PluginCore,
  type PluginScope,
  UserError,
} from "@tofu/plugins/server";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { externalPlugins } from "../plugin-generated/server";
import type { CoreDependencies } from "./core";

const preferenceSchema = Type.Object({
  disabled: Type.Array(Type.String()),
  pages: Type.Array(
    Type.Object({ pageId: Type.String(), pinned: Type.Boolean(), pluginId: Type.String() })
  ),
});
interface Preferences {
  disabled: string[];
  pages: { pluginId: string; pageId: string; pinned: boolean }[];
}

export interface PluginHostOptions {
  load?: (core: PluginCore) => Promise<ErasedPluginDefinition[]>;
}

function publicAuth(
  definition: ErasedPluginDefinition,
  dependencies: CoreDependencies,
  auth: PluginAuth | null
) {
  if (!definition.auth) {
    return null;
  }
  const connected =
    auth?.status().authenticated ??
    (definition.id === "anilist"
      ? (dependencies.automation?.().anilist.snapshot().authenticated ?? false)
      : false);
  return {
    connected,
    label: "label" in definition.auth ? definition.auth.label : "Connect account",
    type: definition.auth.kind,
  };
}

async function pluginAuth(
  definition: PluginAuthDefinition | undefined,
  directory: string,
  id: string,
  scope: PluginScope
): Promise<PluginAuth | null> {
  if (!definition || definition.kind === "custom") {
    return null;
  }
  const credentials = await createCredentialStore({ directory, pluginId: id });
  if (definition.kind === "api-key") {
    return createApiKeyAuth({ credentials });
  }
  const configuredRedirect = definition.redirectUri ? new URL(definition.redirectUri) : null;
  if (
    configuredRedirect &&
    (configuredRedirect.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(configuredRedirect.hostname) ||
      !configuredRedirect.port ||
      configuredRedirect.search ||
      configuredRedirect.hash)
  ) {
    throw new UserError(
      "Plugin OAuth redirects must use a local HTTP callback with an explicit port",
      { status: 400 }
    );
  }
  let auth: OAuth2Auth | undefined;
  const listener = Bun.serve({
    async fetch(request) {
      if (
        request.method !== "GET" ||
        new URL(request.url).pathname !== (configuredRedirect?.pathname ?? "/callback") ||
        !auth
      ) {
        return new Response("OAuth callback not found", { status: 404 });
      }
      try {
        await auth.callback(request.url);
        return new Response("Account connected. You can return to Tofu.", {
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        });
      } catch {
        return new Response("Invalid or expired authorization. Restart the connection from Tofu.", {
          headers: { "cache-control": "no-store" },
          status: 400,
        });
      }
    },
    hostname: configuredRedirect?.hostname ?? "127.0.0.1",
    port: configuredRedirect ? Number(configuredRedirect.port) : 0,
  });
  scope.onDispose(() => listener.stop(true));
  try {
    auth = await createOAuth2Auth({
      ...definition,
      clientAuthentication: definition.clientAuthentication ?? "none",
      credentials,
      redirectUri: configuredRedirect?.href ?? `http://127.0.0.1:${listener.port}/callback`,
      scope,
    });
    return auth;
  } catch (error) {
    listener.stop(true);
    throw error;
  }
}

/** Initializes on the first request so Furin's build inspection cannot open application data. */
export function createPluginHost(dependencies: CoreDependencies, options?: PluginHostOptions) {
  let runtime = createPluginRuntime({ sync: dependencies.sync });
  let definitions: ErasedPluginDefinition[] = [];
  const startupErrors = new Map<string, string>();
  const administration = createAniListApi(dependencies);
  let preferences: Preferences = {
    disabled: [],
    pages: [{ pageId: "library", pinned: true, pluginId: "anilist" }],
  };
  let directory = "";
  let ready: Promise<void> | undefined;
  let pending = Promise.resolve();
  const register = (definition: ErasedPluginDefinition) =>
    runtime.installDefinition({
      auth: (scope) => pluginAuth(definition.auth, directory, definition.id, scope),
      definition,
      directory,
      mountAt: definition.id === "anilist" ? null : undefined,
    });
  const officialEnabled = (id: string) =>
    id === "anilist" && dependencies.automation
      ? (dependencies
          .automation()
          .snapshot()
          .plugins.find((entry) => entry.id === "anilist")?.enabled ?? false)
      : null;
  const initialize = () => {
    ready ??= (async () => {
      const engine = dependencies.engine();
      directory = join(engine.dataDirectory, "plugins");
      const file = Bun.file(join(directory, "host.json"));
      if (await file.exists()) {
        const stored: unknown = await file.json();
        if (!Check(preferenceSchema, stored)) {
          throw new Error("Stored plugin preferences are invalid");
        }
        preferences = stored;
      }
      const core = createCore({
        dashboard: () => structuredClone(engine.snapshot(null, false)),
        thread: (id: string) =>
          structuredClone(
            engine.snapshot(null, false).destinations.find((thread) => thread.id === id) ?? null
          ),
      });
      definitions = [
        createAniListPlugin(dependencies),
        ...(await (options?.load ?? externalPlugins)(core)),
      ];
      await Promise.all(
        definitions.map(async (definition) => {
          try {
            await register(definition);
            if (officialEnabled(definition.id) ?? !preferences.disabled.includes(definition.id)) {
              await runtime.enable(definition.id);
            }
          } catch {
            startupErrors.set(
              definition.id,
              "Plugin startup failed. Check its configuration or reinstall it."
            );
          }
        })
      );
    })();
    return ready.then(async () => {
      const enabled = officialEnabled("anilist");
      if (enabled !== null && !startupErrors.has("anilist")) {
        const active = runtime.list().find((entry) => entry.id === "anilist")?.enabled ?? false;
        if (enabled !== active) {
          await (enabled ? runtime.enable("anilist") : runtime.disable("anilist"));
        }
      }
    });
  };
  const definitionFor = (id: string) => {
    const definition = definitions.find((entry) => entry.id === id);
    if (!definition) {
      throw new UserError("Plugin not found", { status: 404 });
    }
    return definition;
  };
  const enqueue = <T>(operation: () => Promise<T>) => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
  const persist = async (next: Preferences) => {
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `host.${crypto.randomUUID()}.tmp`);
    await Bun.write(temporary, JSON.stringify(next));
    await rename(temporary, join(directory, "host.json"));
    preferences = next;
  };
  return {
    async authorize(id: string, apiKey?: string) {
      const definition = definitionFor(id);
      if (definition.id === "anilist") {
        const service = dependencies.automation?.().anilist;
        if (!service) {
          throw new UserError("AniList unavailable", { status: 503 });
        }
        return service.connect();
      }
      const auth = runtime.auth(id);
      if (!auth) {
        throw new UserError("Enable this plugin before connecting its account", { status: 409 });
      }
      if (definition.auth?.kind === "api-key") {
        if (!(apiKey?.trim() && "connect" in auth) || typeof auth.connect !== "function") {
          throw new UserError("Enter an API key", { status: 400 });
        }
        await auth.connect(apiKey);
        return { url: null };
      }
      return auth.authorize();
    },
    async callback(id: string, url: string) {
      definitionFor(id);
      const auth = runtime.auth(id);
      if (!(auth && "callback" in auth) || typeof auth.callback !== "function") {
        throw new UserError("This plugin does not accept OAuth callbacks", { status: 400 });
      }
      await auth.callback(url);
      return { connected: true };
    },
    async close() {
      if (ready) {
        await ready.catch(() => undefined);
      }
      await pending;
      try {
        await runtime.dispose();
      } finally {
        runtime = createPluginRuntime({ sync: dependencies.sync });
        ready = undefined;
        definitions = [];
        startupErrors.clear();
      }
    },
    async disconnect(id: string) {
      definitionFor(id);
      const auth = runtime.auth(id);
      if (!auth) {
        throw new UserError("This plugin manages its account from its own page", { status: 409 });
      }
      await auth.disconnect();
      return { connected: false };
    },
    async handle(request: Request) {
      await initialize();
      const path = new URL(request.url).pathname;
      const administrative =
        (path === "/api/anilist" && ["GET", "PUT"].includes(request.method)) ||
        (path === "/api/anilist/connect" && ["POST", "DELETE"].includes(request.method)) ||
        (path === "/api/anilist/callback" && request.method === "POST") ||
        (path === "/api/anilist/threads/preview" && request.method === "POST") ||
        (path === "/api/anilist/preferences" && request.method === "PUT");
      if (administrative) {
        return administration.handle(request);
      }
      return runtime.handle(request);
    },
    initialize,
    resetSettings(id: string, threadId?: string) {
      definitionFor(id);
      if (
        threadId &&
        !dependencies
          .engine()
          .snapshot(null, false)
          .destinations.some((thread) => thread.id === threadId)
      ) {
        throw new UserError("Thread not found", { status: 404 });
      }
      const settings = runtime.settings(id);
      if (!settings) {
        throw new UserError("This plugin does not declare settings", { status: 400 });
      }
      return settings.reset(threadId);
    },
    setEnabled(id: string, enabled: boolean) {
      return enqueue(async () => {
        const definition = definitionFor(id);
        if (enabled) {
          try {
            if (!runtime.list().some((entry) => entry.id === id)) {
              await register(definition);
            }
            await runtime.enable(id);
            startupErrors.delete(id);
          } catch (cause) {
            startupErrors.set(
              id,
              "Plugin startup failed. Check its configuration or reinstall it."
            );
            throw new UserError(
              "Unable to start this plugin. Check its configuration or reinstall it.",
              { cause, status: 400 }
            );
          }
        } else if (runtime.list().some((entry) => entry.id === id)) {
          await runtime.disable(id);
        }
        if (id === "anilist") {
          dependencies.automation?.().configure(id, { enabled });
        }
        await persist({
          ...preferences,
          disabled: enabled
            ? preferences.disabled.filter((entry) => entry !== id)
            : [...new Set([...preferences.disabled, id])],
        });
        return { enabled };
      });
    },
    setPage(id: string, pageId: string, pinned: boolean | null) {
      return enqueue(async () => {
        const page = definitionFor(id).ui?.pages?.find((entry) => entry.id === pageId);
        if (!page) {
          throw new UserError("Plugin page not found", { status: 404 });
        }
        if (pinned && !page.pinnable) {
          throw new UserError("This page cannot be pinned", { status: 400 });
        }
        const pages = preferences.pages.filter(
          (entry) => entry.pluginId !== id || entry.pageId !== pageId
        );
        if (pinned !== null) {
          pages.push({ pageId, pinned, pluginId: id });
        }
        await persist({ ...preferences, pages });
        return { created: pinned !== null, pinned: pinned ?? false };
      });
    },
    snapshot(threadId?: string) {
      return {
        plugins: definitions.map((definition) => {
          const installed = runtime.list().find((entry) => entry.id === definition.id);
          const enabled = installed?.enabled ?? false;
          const settings = installed ? runtime.settings(definition.id) : null;
          const auth = installed ? runtime.auth(definition.id) : null;
          return {
            auth: publicAuth(definition, dependencies, auth),
            enabled,
            error: startupErrors.get(definition.id) ?? null,
            id: definition.id,
            name: definition.name,
            pages: (definition.ui?.pages ?? []).map((page) => {
              const created = preferences.pages.find(
                (entry) => entry.pluginId === definition.id && entry.pageId === page.id
              );
              return {
                available: enabled || page.availableWhenDisabled === true,
                created: Boolean(created),
                id: page.id,
                path:
                  definition.id === "anilist"
                    ? "/anilist"
                    : `/extensions/${definition.id}/${page.id}`,
                pinnable: page.pinnable,
                pinned: created?.pinned ?? false,
                title: page.title,
              };
            }),
            schema: settings?.schema ?? null,
            settings: settings?.get(threadId) ?? null,
          };
        }),
      };
    },
    async updateSettings(id: string, patch: unknown, threadId?: string) {
      definitionFor(id);
      if (
        threadId &&
        !dependencies
          .engine()
          .snapshot(null, false)
          .destinations.some((thread) => thread.id === threadId)
      ) {
        throw new UserError("Thread not found", { status: 404 });
      }
      const settings = runtime.settings(id);
      if (!settings) {
        throw new UserError("This plugin does not declare settings", { status: 400 });
      }
      try {
        return await settings.update(patch, threadId);
      } catch (cause) {
        throw new UserError("Plugin settings do not match their schema", { cause, status: 400 });
      }
    },
  };
}

export type PluginHost = ReturnType<typeof createPluginHost>;
