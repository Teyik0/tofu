import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AutomationPreferences, AutomationState } from "../src/types";
import { json } from "./helpers";

test("options expose persisted general preferences without requiring a thread", async () => {
  const ready = Promise.withResolvers<string>();
  const host = Bun.spawn([process.execPath, "tests/anilist-page-host.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, TOFU_TEST_ANILIST_ENDPOINT: "http://127.0.0.1:1" },
    ipc(message: unknown) {
      if (
        message &&
        typeof message === "object" &&
        "url" in message &&
        typeof message.url === "string"
      ) {
        ready.resolve(message.url);
      }
    },
    stderr: "pipe",
    stdout: "ignore",
  });
  const stderr = new Response(host.stderr).text();
  void host.exited.then(async (code) => {
    ready.reject(new Error(`The page server exited with code ${code}: ${await stderr}`));
  });
  try {
    const origin = await ready.promise;
    const state = (await (
      await fetch(new URL("/api/automation", origin))
    ).json()) as AutomationState;
    const preferences: AutomationPreferences = {
      ...state.preferences,
      codecs: ["H.265"],
      languages: ["VOSTFR", "VF"],
      resolutions: ["1080p", "720p"],
      waitMinutes: 35,
    };
    const saved = await fetch(new URL("/api/automation/preferences", origin), {
      ...json(preferences),
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    const page = await fetch(new URL("/options/preferences", origin));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("General preferences");
    expect(html).toContain('href="/options/preferences"');
    expect(html).toContain('id="preferences-language"');
    expect(html).toContain('data-value="VOSTFR,VF"');
    expect(html).toContain('data-value="1080p,720p"');
    expect(html).toContain('data-value="H.265"');
    expect(html).toContain("Save preferences");
    expect(html).not.toContain("Changes apply automatically.");
    expect(html).not.toContain('id="automation-destination"');
    const general = await fetch(new URL("/options", origin));
    expect(await general.text()).toContain('href="/options/preferences"');
  } finally {
    host.kill("SIGTERM");
    await host.exited;
  }
});
