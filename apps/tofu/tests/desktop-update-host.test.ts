import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../src/api/index";
import type { DashboardState, ServerInfo } from "../src/types";
import { launchNativeUpdateHost } from "./helpers/native-update-host";
import { expectSuccess } from "./helpers/problem";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

test
  .skipIf(process.platform === "win32" && process.env.FURIN_NATIVE_RESTART_TEST !== "1")
  .each(["success", "reported", "throw", "cancelled"] as const)(
  "the standard desktop host preserves real transfers through native update handoff: %s",
  async (handoff) => {
    const context = await fixture(256 * 1024, []);
    const dataDir = join(context.directory, "native-state");
    const downloadPath = join(context.directory, "native-downloads");
    const { child, output, events, ready, stop } = await launchNativeUpdateHost({
      dataDir,
      directory: context.directory,
      downloadPath,
      handoff,
      magnet: context.magnet,
    });
    const deadline = setTimeout(() => child.kill(), 25_000);
    try {
      await ready;
      const server = await waitFor(
        async () => {
          if (child.exitCode !== null) {
            throw new Error((await output).join("\n"));
          }
          const file = Bun.file(join(dataDir, "server.json"));
          return (await file.exists()) ? ((await file.json()) as ServerInfo) : null;
        },
        (value) => value !== null
      );
      if (!server) {
        throw new Error("The native host did not start");
      }
      let client = treaty<Api>(server.url, { headers: { cookie: server.cookie ?? "" } }).api;
      expect((await treaty<Api>(server.url).api.state.get()).status).toBe(403);
      expect(expectSuccess(await client.instance.get())).toMatchObject({
        dataDir,
        desktop: true,
        profile: "dev",
      });
      const shown = await waitFor(
        async () => {
          const file = Bun.file(join(context.directory, "native-error.json"));
          return (await file.exists()) ? await file.json() : null;
        },
        (value) => value !== null,
        2000
      );
      expect(shown).toMatchObject({
        detail: "Only magnet links and .torrent files can be opened",
        message: "Unable to open link",
      });
      const id = context.seed.infoHash;
      const state = async () => expectSuccess(await client.state.get()) as DashboardState;
      await waitFor(state, (value) =>
        value.torrents.some((torrent) => torrent.id === id && torrent.status === "seeding")
      );
      expectSuccess(
        await client.settings.put({ ...(await state()).settings, runInBackground: true })
      );
      expect((await client.desktop.background.post({})).status).toBe(200);
      await waitFor(
        async () => expectSuccess(await client.desktop.get()),
        (value) => value.background
      );
      expect((await client.desktop.open.post({})).status).toBe(200);
      expectSuccess(await client.torrents({ id }).pause.post({}));
      child.send("install");
      const approval = await waitFor(
        async () => {
          const file = Bun.file(join(context.directory, "quit-approval.json"));
          if (await file.exists()) {
            return file.json();
          }
          const failure = Bun.file(join(context.directory, "native-error.json"));
          if (await failure.exists()) {
            const message = await failure.json();
            if (message.title === "Update failed") {
              throw new Error(message.detail);
            }
          }
          if (child.exitCode !== null) {
            throw new Error((await output).join("\n"));
          }
          return null;
        },
        (value) => value !== null
      );
      expect(approval.vetoed).toBe(false);
      if (handoff === "success") {
        const installed = await waitFor(
          async () => {
            const file = Bun.file(join(context.directory, "install-result.json"));
            return (await file.exists()) ? await file.json() : null;
          },
          (value) => value !== null
        );
        expect(installed.error).toBeNull();
        expect((await client.state.get()).status).toBe(503);
      } else {
        const replacement = await waitFor(
          async () => {
            const file = Bun.file(join(dataDir, "server.json"));
            return (await file.exists()) ? ((await file.json()) as ServerInfo) : null;
          },
          (value) => value !== null && value.pid !== server.pid
        );
        if (!replacement) {
          throw new Error("The replacement native host did not start");
        }
        expect(await child.exited, (await output).join("\n")).toBe(0);
        expect(replacement.pid).not.toBe(server.pid);
        expect(() => process.kill(server.pid, 0)).toThrow();
        expect(replacement.cookie).not.toBe(server.cookie);
        expect(
          (
            await treaty<Api>(replacement.url, {
              headers: { cookie: server.cookie ?? "" },
            }).api.state.get()
          ).status
        ).toBe(403);
        client = treaty<Api>(replacement.url, {
          headers: { cookie: replacement.cookie ?? "" },
        }).api;
        const launches = (await Bun.file(events).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; pid: number });
        expect(launches.slice(0, 3).map((event) => event.type)).toEqual(["start", "exit", "start"]);
        expect(launches[0]?.pid).toBe(child.pid);
        expect(launches[2]?.pid).not.toBe(child.pid);
        expect((await client.health.get()).status).toBe(200);
        expect((await state()).torrents.find((torrent) => torrent.id === id)?.status).toBe(
          "paused"
        );
        const bytes = torrentBytes(
          await client.torrents({ id }).files({ index: "0" }).content.get()
        );
        expect(Bun.SHA256.hash(bytes, "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
        expect((await client.desktop.background.post({})).status).toBe(200);
      }
      expect(await Bun.file(join(downloadPath, context.seed.name)).bytes()).toEqual(context.bytes);
    } finally {
      clearTimeout(deadline);
      await stop();
      await context.close();
    }
  },
  30_000
);
