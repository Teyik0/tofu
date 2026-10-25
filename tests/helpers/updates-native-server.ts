import type { Updater } from "electrobun/main";
import { servicesRuntime } from "../../src/api/lib/services-runtime";
import { Updates } from "../../src/api/modules/updates/service";

const info: ReturnType<typeof Updater.updateInfo> = {
  error: "",
  hash: "integration-update",
  updateAvailable: true,
  updateReady: false,
  version: "99.0.0",
};

// Only the native SDK boundary is simulated; API routes and application services are real.
const native = {
  async checkForUpdate() {
    await Bun.sleep(0);
    return { ...info };
  },
  async downloadUpdate() {
    await Bun.sleep(50);
    info.updateReady = true;
  },
  onStatusChange(callback: Parameters<typeof Updater.onStatusChange>[0]) {
    process.send?.({ active: callback !== null, type: "updates-listener" });
  },
  updateInfo() {
    return { ...info };
  },
} satisfies Pick<
  typeof Updater,
  "checkForUpdate" | "downloadUpdate" | "onStatusChange" | "updateInfo"
>;

const updates = await servicesRuntime.runPromise(Updates);
await servicesRuntime.runPromise(
  updates.attachNative(
    native as unknown as typeof Updater,
    async () => {
      await servicesRuntime.dispose();
      process.send?.({ type: "updates-installed" });
    },
    (version) => process.send?.({ type: "update-available", version })
  )
);

await import("./updates-server");
