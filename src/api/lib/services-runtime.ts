import "@teyik0/furin/server-only";
import { Effect, ManagedRuntime } from "effect";
import { servicesLayer } from "./services-layer";

export const servicesRuntime = ManagedRuntime.make(servicesLayer);

// A failed graph acquisition must release successful siblings before import rejects.
export const services = await Effect.runPromise(
  servicesRuntime.contextEffect.pipe(Effect.onError(() => servicesRuntime.disposeEffect))
);
