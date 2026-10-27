import "@teyik0/furin/server-only";
import { Context, Effect, ManagedRuntime } from "effect";
import { Elysia } from "elysia";
import { Database } from "./db";
import { servicesLayer } from "./services-layer";

export const servicesRuntime = ManagedRuntime.make(servicesLayer);

// A failed graph acquisition must release successful siblings before import rejects.
export const services = await Effect.runPromise(
  servicesRuntime.contextEffect.pipe(Effect.onError(() => servicesRuntime.disposeEffect))
);

export const db = Context.get(services, Database);
export const databasePlugin = new Elysia({ name: "tofu-database-service" }).decorate("db", db);
