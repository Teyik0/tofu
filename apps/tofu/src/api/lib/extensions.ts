import { sync } from "../../sync";
import type { Application, EnginePort } from "../../types";
import { createPluginHost, type PluginHostOptions } from "../plugin-host";
import { UserError } from "./errors";
import { applicationHost, applicationScope } from "./host";

const hosts = new WeakMap<Application["automation"], ReturnType<typeof createPluginHost>>();
const lifetimes = new WeakMap<
  EnginePort,
  Map<Application["automation"], ReturnType<typeof createPluginHost>>
>();

export function currentApplication(): Application {
  const scoped = applicationScope.getStore();
  if (scoped) {
    return scoped;
  }
  const { state } = applicationHost;
  if (state.phase !== "ready") {
    throw new UserError("Tofu is temporarily unavailable", { status: 503 });
  }
  return state.application;
}

export function pluginHost() {
  return createApplicationPluginHost(currentApplication());
}

export function createApplicationPluginHost(application: Application, options?: PluginHostOptions) {
  let host = hosts.get(application.automation);
  if (!host) {
    host = createPluginHost(
      {
        application: () => application,
        automation: () => application.automation,
        directory: application.instance.dataDir,
        engine: () => application.engine,
        sync,
      },
      options
    );
    hosts.set(application.automation, host);
    let owned = lifetimes.get(application.engine);
    if (!owned) {
      owned = new Map();
      lifetimes.set(application.engine, owned);
    }
    owned.set(application.automation, host);
  }
  return host;
}

export async function closePluginHost(engine: EnginePort) {
  const owned = lifetimes.get(engine);
  lifetimes.delete(engine);
  if (owned) {
    const resources = new AsyncDisposableStack();
    for (const [automation, host] of owned) {
      hosts.delete(automation);
      resources.defer(() => host.close());
    }
    await resources.disposeAsync();
  }
}
