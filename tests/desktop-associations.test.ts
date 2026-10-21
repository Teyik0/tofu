import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
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

test.each([false, true])(
  "opening application logs is guarded for desktop=%s",
  async (isDesktop) => {
    const opened: string[] = [];
    const app = await createTestAniListOpeningApi({
      isDesktop: () => isDesktop,
      openExternal: () => false,
      openPath(path) {
        opened.push(path);
        return true;
      },
    });
    const client = treaty(app).api;
    const result = await client.desktop.logs.open.post({});
    expect(result.status).toBe(isDesktop ? 200 : 409);
    expect(opened).toEqual(isDesktop ? [join(app.application.instance.dataDir, "logs")] : []);
  }
);
