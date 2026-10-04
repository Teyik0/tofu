import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopController } from "./desktop";
import { type TorrentEngine, UserError } from "./engine";
import type { AutomationService } from "./feeds/service";
import { createTofuSync } from "./sync";
import type { UpdatesService } from "./updates";

const applicationDir =
  process.platform === "darwin"
    ? join(homedir(), "Library/Application Support/Tofu")
    : join(homedir(), ".local/share/Tofu");
export const dataDir = process.env.TOFU_DATA_DIR ?? applicationDir;

// Bun hot reload replaces HTTP modules without restarting downloads or the journal.
const host = globalThis as typeof globalThis & {
  tofuRuntime?: {
    engine?: TorrentEngine;
    sync?: Awaited<ReturnType<typeof createTofuSync>>;
    shutdown?: () => Promise<void>;
    timer?: ReturnType<typeof setInterval>;
    publishing?: Promise<void>;
    automation?: AutomationService;
    updates?: UpdatesService;
    desktop?: DesktopController;
  };
};
host.tofuRuntime ??= {};
export const runtime = host.tofuRuntime;
runtime.sync ??= await createTofuSync(dataDir);
export const { sync } = runtime;

export function getEngine() {
  if (!runtime.engine) {
    throw new UserError("Le moteur démarre, veuillez patienter", { status: 503 });
  }
  return runtime.engine;
}
export function getAutomation() {
  if (!runtime.automation) {
    throw new UserError("Les automatisations démarrent", { status: 503 });
  }
  return runtime.automation;
}

export function getUpdates() {
  if (!runtime.updates) {
    throw new UserError("Les mises à jour démarrent", { status: 503 });
  }
  return runtime.updates;
}
export function getDesktop() {
  if (!runtime.desktop) {
    throw new UserError("L’application de bureau démarre", { status: 503 });
  }
  return runtime.desktop;
}
