import "@teyik0/furin/server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Application, ApplicationInstance, NativeSdk } from "../../types";
import { ApplicationHost } from "./application-host";
import { currentInstanceConfig } from "./instance";

// Preserve the lifecycle owner and configuration across Bun hot reload.
const processHost = globalThis as typeof globalThis & {
  tofuApplicationHost?: ApplicationHost;
  tofuApplicationScope?: AsyncLocalStorage<Application>;
  tofuInstance?: Promise<ApplicationInstance>;
  tofuNativeSdk?: NativeSdk;
  tofuShutdown?: () => Promise<void>;
};
processHost.tofuApplicationHost ??= new ApplicationHost();
processHost.tofuInstance ??= currentInstanceConfig();
export const applicationHost = processHost.tofuApplicationHost;
// Direct SSR calls retain the application selected by their parent transport.
processHost.tofuApplicationScope ??= new AsyncLocalStorage<Application>();
export const applicationScope = processHost.tofuApplicationScope;
export const instance = await processHost.tofuInstance;
export const hostIntegration = processHost;
