import { Elysia } from "elysia";

/** A route-free capability facade over the host's single engine. */
export function createCore<const Capabilities extends object>(capabilities: Capabilities) {
  return new Elysia({ name: "tofu-plugin-core" }).decorate("core", capabilities);
}

/** Optional intelligence capability; the host remains responsible for credentials. */
export function createJev<const Capabilities extends object>(capabilities: Capabilities) {
  return new Elysia({ name: "tofu-plugin-jev" }).decorate("jev", capabilities);
}
