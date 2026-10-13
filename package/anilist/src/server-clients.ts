import "@teyik0/furin/server-only";

// biome-ignore lint/performance/noBarrelFile: The host binds the same live clients used by the autonomous UI.
export { bindAniListClients } from "./client-api";
