import type { FurinSyncOptions } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import type { InstanceConfig } from "../types";
import type { DesktopController } from "./desktop";
import { type TorrentEngine, UserError } from "./engine";
import type { AutomationService } from "./feeds/service";
import {
  getAutomation,
  getDesktop,
  getEngine,
  getNativeSdk,
  getUpdates,
  instance,
  syncOptions,
} from "./runtime";
import type { UpdatesService } from "./updates";

export interface CoreServices {
  desktop: () => DesktopController;
  instance?: () => InstanceConfig;
  nativeSdk?: () => typeof import("electrobun/main");
  updates: () => UpdatesService;
}

// Route-free dependencies can be reused under a plugin's own HTTP prefix.
export interface CoreDependencies {
  automation?: () => AutomationService;
  engine: () => TorrentEngine;
  services?: CoreServices;
  sync: FurinSyncOptions;
}

export function createCore(dependencies: CoreDependencies) {
  return new Elysia({ name: "tofu-core" }).decorate("core", dependencies);
}

export const coreDependencies: CoreDependencies = {
  automation: getAutomation,
  engine: getEngine,
  services: {
    desktop: getDesktop,
    instance: () => instance,
    nativeSdk: getNativeSdk,
    updates: getUpdates,
  },
  sync: syncOptions,
};

export const core = createCore(coreDependencies);

export function unavailableAutomation(): AutomationService {
  throw new UserError("Automations unavailable", { status: 503 });
}
