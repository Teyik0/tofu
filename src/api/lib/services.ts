import "@teyik0/furin/server-only";
import type { DrizzleSqliteSyncAdapter } from "@teyik0/furin/sync/drizzle";
import type { EnginePort } from "../../types";
import type { TofuDatabase } from "./db";
import { getAutomation, getDesktop, getNativeSdk, getUpdates, instance, runtime } from "./runtime";

// Startup binds required resources before the host listens. Registration never opens them.
export class Services {
  declare syncAdapter: DrizzleSqliteSyncAdapter<TofuDatabase>;
  declare engine: EnginePort;

  get automation() {
    return getAutomation();
  }
  get desktop() {
    return getDesktop();
  }
  get instance() {
    return runtime.instance ?? instance;
  }
  get isDesktop() {
    return this.engine.mode === "desktop";
  }
  get nativeSdk() {
    return getNativeSdk();
  }
  openExternal(url: string) {
    return Promise.resolve(getNativeSdk().Utils.openExternal(url));
  }
  get updates() {
    return getUpdates();
  }
}

// Keep the same service bindings when Bun replaces HTTP modules during hot reload.
runtime.services ??= new Services();
export const { services } = runtime;
