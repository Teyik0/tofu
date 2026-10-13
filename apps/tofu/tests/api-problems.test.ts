import { afterEach, expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { closeTestOpeningApplications, createTestAniListOpeningApi } from "./helpers/application";
import { expectProblem } from "./helpers/problem";
import { fixture } from "./helpers/torrent";

afterEach(closeTestOpeningApplications);
test("public API errors preserve status and Problem Details outside success data", async () => {
  const context = await fixture(4096, []);
  try {
    const directory = await context.client.directory.post({});
    expectProblem(directory, 409, "Enter the folder path on the server");
    expect(directory.data).toBeNull();
    const missing = await context.client.torrents({ id: "missing" }).get();
    expectProblem(missing, 404, "Torrent not found");
    expect(missing.data).toBeNull(); // Send an intentionally invalid payload past the typed client to exercise server validation.
    const invalid = await context.client.torrents.post({ source: 42 } as never);
    expect(invalid.status).toBe(422);
    expect(invalid.data).toBeNull();
    expect(invalid.response.headers.get("content-type")).toBe("application/problem+json");
    expect(invalid.error?.value).toMatchObject({
      code: "validation",
      status: 422,
      type: "validation",
    });
  } finally {
    await context.close();
  }
});
test("opening a desktop download without an available update returns a conflict", async () => {
  const app = await createTestAniListOpeningApi({
    isDesktop: () => true,
    openExternal: () => false,
  });
  const { api } = treaty(app);
  expectProblem(await api.updates["open-download"].post({}), 409, "No update available");
});
