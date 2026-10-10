import type { EnginePort } from "../../types";
import type { AutomationService } from "../modules/automation/service";
import type { DesktopController } from "../modules/desktop/service";
import type { UpdatesService } from "../modules/updates/service";
import type { TofuDatabase } from "./db";
import { UserError } from "./errors";
import { type acquireInstance, currentInstanceConfig } from "./instance";
import type { Services } from "./services";

// Bun hot reload replaces HTTP modules without restarting downloads or the journal.
const host = globalThis as typeof globalThis & {
  tofuRuntime?: {
    instance?: Awaited<ReturnType<typeof currentInstanceConfig>>;
    engine?: EnginePort;
    services?: Services;
    starting?: Promise<void>;
    startupController?: AbortController;
    closing?: boolean;
    db?: TofuDatabase;
    shutdown?: () => Promise<void>;
    timer?: ReturnType<typeof setInterval>;
    publishing?: Promise<void>;
    automation?: AutomationService;
    updates?: UpdatesService;
    desktop?: DesktopController;
    lease?: Awaited<ReturnType<typeof acquireInstance>>;
    sdk?: typeof import("electrobun/main");
  };
};
host.tofuRuntime ??= {};
export const runtime = host.tofuRuntime;
// Keep the configuration with the engine: hot reload must never relabel a live database.
runtime.instance ??= await currentInstanceConfig();
export const { instance } = runtime;
export const { dataDir } = instance;

export function getAutomation() {
  if (!runtime.automation) {
    throw new UserError("Automations are starting", { status: 503 });
  }
  return runtime.automation;
}

export function getUpdates() {
  if (!runtime.updates) {
    throw new UserError("Updates are starting", { status: 503 });
  }
  return runtime.updates;
}
export function getDesktop() {
  if (!runtime.desktop) {
    throw new UserError("The desktop app is starting", { status: 503 });
  }
  return runtime.desktop;
}

export function getNativeSdk() {
  if (!runtime.sdk) {
    throw new UserError("The native host is starting", { status: 503 });
  }
  return runtime.sdk;
}
