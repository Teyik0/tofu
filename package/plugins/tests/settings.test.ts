import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createSettingsStore } from "../src/server";

test("settings persist global values and thread overrides across plugin reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-settings-"));
  try {
    const options = {
      definition: {
        defaults: { language: "en", limit: 10 },
        schema: Type.Object({ language: Type.String(), limit: Type.Number() }),
      },
      directory,
      pluginId: "test-plugin",
    };
    const settings = await createSettingsStore(options);
    await settings.update({ limit: 20 });
    await settings.update({ language: "ja" }, "thread-one");
    await settings.update({ limit: 30 });
    const restored = await createSettingsStore(options);
    expect(restored.get()).toEqual({ language: "en", limit: 30 });
    expect(restored.get("thread-one")).toEqual({ language: "ja", limit: 30 });
    expect(restored.get("thread-two")).toEqual({ language: "en", limit: 30 });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("invalid settings updates leave the previous persisted values intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-settings-validation-"));
  try {
    const options = {
      definition: {
        defaults: { limit: 5 },
        schema: Type.Object({ limit: Type.Number({ minimum: 1 }) }),
      },
      directory,
      pluginId: "validation-plugin",
    };
    const settings = await createSettingsStore(options);
    await settings.update({ limit: 10 });
    await expect(settings.update({ limit: 0 })).rejects.toThrow("schema");
    const restored = await createSettingsStore(options);
    expect(restored.get()).toEqual({ limit: 10 });
    await restored.update({ limit: 3 }, "thread-one");
    expect(await restored.reset("thread-one")).toEqual({ limit: 10 });
    expect(await restored.reset()).toEqual({ limit: 5 });
  } finally {
    await rm(directory, { recursive: true });
  }
});
