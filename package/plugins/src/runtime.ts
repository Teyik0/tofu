import type { FurinSyncOptions } from "@teyik0/furin/sync";
import { type AnyElysia, Elysia } from "elysia";
import type { TObject } from "typebox";
import { createPluginApi } from "./api";
import type { PluginAuth } from "./auth";
import {
  type ErasedPluginDefinition,
  installPluginDefinition,
  type PluginDefinitionInstaller,
  type PluginInstallationOptions,
} from "./definition";
import { createPluginScope, type PluginScope } from "./lifecycle";
import {
  createSettingsController,
  createSettingsStore,
  type PluginSettings,
  type PluginSettingsController,
  validatePluginId,
} from "./settings";
import type { PluginUI } from "./ui";

const mountParameterPattern = /[*{}]/;

export interface PluginRegistration {
  auth?: () => PluginAuth | null;
  create: (scope: PluginScope) => AnyElysia | Promise<AnyElysia>;
  id: string;
  /** Null preserves absolute routes for host-owned compatibility adapters. */
  mountAt?: string | null;
  settings?: PluginSettingsController;
  ui?: PluginUI;
}

export interface InstalledPlugin {
  enabled: boolean;
  id: string;
}

export interface PluginRuntime {
  auth: (id: string) => PluginAuth | null;
  contributions: () => { id: string; ui: PluginUI }[];
  disable: (id: string) => Promise<void>;
  dispose: () => Promise<void>;
  enable: (id: string) => Promise<void>;
  handle: (request: Request) => Promise<Response>;
  install: (registration: PluginRegistration) => Promise<void>;
  installDefinition: (
    options: PluginInstallationOptions & { definition: ErasedPluginDefinition }
  ) => Promise<void>;
  list: () => InstalledPlugin[];
  settings: (id: string) => PluginSettingsController | null;
  uninstall: (id: string) => Promise<void>;
}

interface Entry {
  active: { scope: PluginScope; api: AnyElysia } | null;
  registration: PluginRegistration;
}

/** Elysia has no unuse: rebuild the route registry while retaining the host engine. */
export function createPluginRuntime(options?: { sync?: FurinSyncOptions }): PluginRuntime {
  const entries = new Map<string, Entry>();
  let app: AnyElysia = options?.sync ? createPluginApi(options) : new Elysia();
  let pending = Promise.resolve();
  let disposed = false;
  const enqueue = (operation: () => void | Promise<void>) => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const assertOpen = () => {
    if (disposed) {
      throw new Error("The plugin runtime has been disposed");
    }
  };
  const requireEntry = (id: string) => {
    const entry = entries.get(id);
    if (!entry) {
      throw new Error(`Plugin ${id} is not installed`);
    }
    return entry;
  };
  const rebuild = () => {
    let next: AnyElysia = options?.sync ? createPluginApi(options) : new Elysia();
    for (const [id, entry] of entries) {
      if (entry.active) {
        const { api } = entry.active;
        const { mountAt } = entry.registration;
        next =
          mountAt === null
            ? next.use(api)
            : next.group(mountAt ?? `/api/plugins/${id}`, (group) => group.use(api));
      }
    }
    app = next;
  };
  const disable = async (entry: Entry) => {
    const { active } = entry;
    if (!active) {
      return;
    }
    entry.active = null;
    rebuild();
    await active.scope.dispose();
  };
  const install = (registration: PluginRegistration) =>
    enqueue(() => {
      assertOpen();
      validatePluginId(registration.id);
      if (
        registration.mountAt !== undefined &&
        registration.mountAt !== null &&
        (!registration.mountAt.startsWith("/") || mountParameterPattern.test(registration.mountAt))
      ) {
        throw new Error(
          "Plugin mount paths must be absolute paths without wildcards or parameters"
        );
      }
      if (entries.has(registration.id)) {
        throw new Error(`Plugin ${registration.id} is already installed`);
      }
      entries.set(registration.id, { active: null, registration });
    });
  const installTypedDefinition: PluginDefinitionInstaller = async (
    definition,
    { directory, auth, mountAt }
  ) => {
    const settings = definition.settings
      ? await createSettingsStore({
          definition: definition.settings,
          directory,
          pluginId: definition.id,
        })
      : unavailableSettings();
    const controller = definition.settings
      ? createSettingsController(definition.settings, settings)
      : undefined;
    let activeAuth: PluginAuth | null = null;
    await install({
      auth: () => activeAuth,
      async create(scope) {
        const scopedAuth = typeof auth === "function" ? await auth(scope) : (auth ?? null);
        activeAuth = scopedAuth;
        scope.onDispose(() => {
          activeAuth = null;
        });
        const context = { auth: scopedAuth, scope, settings, sync: options?.sync };
        await definition.setup?.(context);
        return typeof definition.api === "function" ? definition.api(context) : definition.api;
      },
      id: definition.id,
      mountAt,
      settings: controller,
      ui: definition.ui,
    });
  };
  return {
    auth(id) {
      const entry = requireEntry(id);
      return entry.active ? (entry.registration.auth?.() ?? null) : null;
    },
    contributions() {
      return [...entries].flatMap(([id, entry]) =>
        entry.active && entry.registration.ui ? [{ id, ui: entry.registration.ui }] : []
      );
    },
    disable(id) {
      return enqueue(async () => {
        assertOpen();
        await disable(requireEntry(id));
      });
    },
    dispose() {
      return enqueue(async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const scopes = [...entries.values()].flatMap((entry) =>
          entry.active ? [entry.active.scope] : []
        );
        for (const entry of entries.values()) {
          entry.active = null;
        }
        rebuild();
        const results = await Promise.allSettled(scopes.map((scope) => scope.dispose()));
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        if (errors.length > 0) {
          throw new AggregateError(errors, "Plugin runtime disposal failed");
        }
      });
    },
    enable(id) {
      return enqueue(async () => {
        assertOpen();
        const entry = requireEntry(id);
        if (entry.active) {
          return;
        }
        const scope = createPluginScope();
        try {
          const api = await entry.registration.create(scope);
          entry.active = { api, scope };
          rebuild();
        } catch (error) {
          entry.active = null;
          rebuild();
          await scope.dispose();
          throw error;
        }
      });
    },
    async handle(request) {
      return await app.handle(request);
    },
    install,
    installDefinition({ definition, ...installation }) {
      return definition[installPluginDefinition](installTypedDefinition, installation);
    },
    list() {
      return [...entries].map(([id, entry]) => ({ enabled: entry.active !== null, id }));
    },
    settings(id) {
      return requireEntry(id).registration.settings ?? null;
    },
    uninstall(id) {
      return enqueue(async () => {
        assertOpen();
        const entry = requireEntry(id);
        try {
          await disable(entry);
        } finally {
          entries.delete(id);
        }
      });
    },
  };
}

function unavailableSettings<Schema extends TObject>(): PluginSettings<Schema> {
  const error = () => new Error("This plugin does not declare settings");
  return {
    get() {
      throw error();
    },
    reset() {
      return Promise.reject(error());
    },
    update() {
      return Promise.reject(error());
    },
  };
}
