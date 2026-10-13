import { afterAll, expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { closeTestOpeningApplications, createTestAniListOpeningApi } from "./helpers/application";

afterAll(closeTestOpeningApplications);
test.each([false, true])(
  "the default torrent file API is guarded for desktop=%s",
  async (isDesktop) => {
    const api = await createTestAniListOpeningApi({
      isDesktop: () => isDesktop,
      openExternal: () => false,
    });
    const client = treaty(api).api;
    const result = await client.desktop.associations.torrent.post({});
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.error?.value ?? result.data)).toContain(
      isDesktop ? "Use the installed release of Tofu" : "This action requires the desktop app"
    );
  }
);
