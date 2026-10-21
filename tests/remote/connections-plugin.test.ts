import { expect, test } from "bun:test";
import { lockDataDirectory } from "../../src/api/lib/instance-lock";
import { embeddedTailscaleFixture } from "../helpers/embedded-tailscale";
import { expectProblem, expectSuccess } from "../helpers/problem";
import { fixture } from "../helpers/torrent";

test.skipIf(process.platform === "win32")(
  "the composed API preserves refused exposure changes and releases its native process, database and instance lock",
  async () => {
    const context = await fixture(4096, []);
    const native = await embeddedTailscaleFixture(context.directory);
    const previous = process.env.TOFU_TSNET_BINARY;
    process.env.TOFU_TSNET_BINARY = native.binary;
    try {
      // Direct dispatch can succeed before startup begins; wait for the listener to be ready.
      await new Promise<void>((resolve) => {
        context.api.listen({ hostname: "127.0.0.1", port: 0 }, () => resolve());
      });
      expectProblem(
        await context.client.connections.put({
          enabled: true,
          tailscaleMode: "embedded",
          transport: "tailscale",
        }),
        409,
        "Tofu is connected to Tailscale, but HTTPS certificates are disabled. Open Tailscale admin → DNS → HTTPS Certificates → Enable HTTPS, then check the connection and apply again"
      );
      expect(expectSuccess(await context.client.connections.get()).config.tailscale.enabled).toBe(
        false
      );

      await Bun.write(native.configuration, JSON.stringify({ httpsEnabled: true }));
      expectSuccess(
        await context.client.connections.put({
          enabled: true,
          tailscaleMode: "embedded",
          transport: "tailscale",
        })
      );
      expect(expectSuccess(await context.client.connections.get()).exposures.tailscale.state).toBe(
        "ready"
      );
      expect(Bun.spawnSync(["ps", "-axo", "command"]).stdout.toString()).toContain(native.binary);

      await context.api.stop(true);
      expect(Bun.spawnSync(["ps", "-axo", "command"]).stdout.toString()).not.toContain(
        native.binary
      );
      expect(() => context.sync.db.$client.query("SELECT 1").get()).toThrow();
      const lock = await lockDataDirectory(context.sync.options.directory);
      lock.close();
    } finally {
      try {
        if (context.api.server) {
          await context.api.stop(true);
        }
      } finally {
        if (previous === undefined) {
          delete process.env.TOFU_TSNET_BINARY;
        } else {
          process.env.TOFU_TSNET_BINARY = previous;
        }
        await context.close();
      }
    }
  },
  30_000
);
