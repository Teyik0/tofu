import { Elysia } from "elysia";

/** A route-free capability facade over the host's single engine. */
export function createCore<const Capabilities extends object>(capabilities: Capabilities) {
  return new Elysia({ name: "tofu-plugin-core" }).decorate("core", capabilities);
}
