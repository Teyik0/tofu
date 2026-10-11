import "@teyik0/furin/server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Application } from "../../types";
import { ApplicationHost } from "./application-host";

// Preserve the lifecycle owner and configuration across Bun hot reload.
const processHost = globalThis as typeof globalThis & {
  tofuApplicationHost?: ApplicationHost;
  tofuApplicationScope?: AsyncLocalStorage<Application>;
  tofuRequestScope?: AsyncLocalStorage<Request>;
  tofuShutdown?: () => Promise<void>;
};
processHost.tofuApplicationHost ??= new ApplicationHost();
export const applicationHost = processHost.tofuApplicationHost;
// Direct SSR calls retain the application selected by their parent transport.
processHost.tofuApplicationScope ??= new AsyncLocalStorage<Application>();
export const applicationScope = processHost.tofuApplicationScope;
processHost.tofuRequestScope ??= new AsyncLocalStorage<Request>();
export const requestScope = processHost.tofuRequestScope;
export const hostIntegration = processHost;
