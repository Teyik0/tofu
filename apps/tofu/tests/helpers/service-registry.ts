import type { ApplicationPlatform } from "../../src/types";
import type { createTestApplication } from "./application";

export const serviceApplications = new Map<
  string,
  {
    application: Awaited<ReturnType<typeof createTestApplication>>;
    platform: ApplicationPlatform;
  }
>();
