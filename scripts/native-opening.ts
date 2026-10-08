// biome-ignore-all lint/performance/noAwaitInLoops: observe native startup and real transfers sequentially.
import { dirname, join } from "node:path";
import { Server as Tracker } from "bittorrent-tracker";
import { desktopLauncher, hostDesktopTarget } from "../src/platform";
import type { AniListState, DashboardState, ServerInfo } from "../src/types";
import { fixture, json, waitFor } from "../tests/helpers";
import { nativeRequest } from "./native-request";

if (process.platform !== "darwin") {
  throw new Error("Native file associations are currently supported on macOS");
}

const root = join(import.meta.dir, "..");
const bundle = dirname(dirname(dirname(desktopLauncher(root, hostDesktopTarget(), "dev"))));
const tracker = new Tracker({ http: true, stats: false, udp: false, ws: false });
await new Promise<void>((resolve) => tracker.listen(0, "127.0.0.1", resolve));
const address = tracker.http.address();
if (!address || typeof address === "string") {
  throw new Error("Tracker not started");
}
const file = await fixture(
  65_536,
  [`http://127.0.0.1:${address.port}/announce`],
  "Native file.bin"
);
const magnet = await fixture(65_536, [], "Native magnet.bin");
const dataDir = join(file.directory, "native-state");
const downloadPath = join(file.directory, "native-downloads");
const torrentPath = join(file.directory, "Open torrent #1.torrent");
await Bun.write(torrentPath, file.seed.torrentFile);
let server: ServerInfo | null = null;
const checks: string[] = [];

async function open(args: string[]) {
  const child = Bun.spawn(["/usr/bin/open", ...args], { stderr: "pipe", stdout: "pipe" });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) {
    throw new Error(error);
  }
}

function request(url: string, init?: RequestInit) {
  if (!server) {
    throw new Error("The native instance is unavailable");
  }
  return nativeRequest(server, url, init);
}

try {
  await open([
    "-n",
    "-a",
    bundle,
    "--env",
    `TOFU_DATA_DIR=${dataDir}`,
    "--env",
    `TOFU_DOWNLOAD_DIR=${downloadPath}`,
    "--env",
    "TOFU_MODE=desktop",
    "--env",
    "TOFU_PORT=0",
    "--stdout",
    join(file.directory, "native.log"),
    "--stderr",
    join(file.directory, "native-error.log"),
    torrentPath,
  ]);
  server = await waitFor(
    async () => {
      const info = Bun.file(join(dataDir, "server.json"));
      return (await info.exists()) ? ((await info.json()) as ServerInfo) : null;
    },
    (value) => value !== null
  );
  if (!server) {
    throw new Error("Native server did not start");
  }
  const base = server.url;
  const state = async () => (await (await request(`${base}/api/state`)).json()) as DashboardState;
  const downloaded = async (id: string, bytes: Uint8Array) => {
    await waitFor(state, (value) =>
      value.torrents.some((torrent) => torrent.id === id && torrent.status === "seeding")
    );
    const content = await request(`${base}/api/torrents/${id}/files/0/content`);
    if (
      !content.ok ||
      Bun.SHA256.hash(await content.arrayBuffer(), "hex") !== Bun.SHA256.hash(bytes, "hex")
    ) {
      throw new Error("Native torrent contents do not match the real peer");
    }
  };
  await downloaded(file.seed.infoHash, file.bytes);
  checks.push("Cold launch from a .torrent file downloads exact bytes from a real peer");

  await open(["-a", bundle, "-u", magnet.magnet]);
  await downloaded(magnet.seed.infoHash, magnet.bytes);
  checks.push("A magnet link reaches the running app and downloads exact bytes");

  const configured = (await (await request(`${base}/api/anilist`)).json()) as AniListState;
  if (configured.clientId !== "52735" || configured.redirectUri !== "tofu-dev://oauth/anilist") {
    throw new Error("The development bundle must use its own AniList client and callback");
  }
  const authorization = await request(`${base}/api/anilist/connect`, { method: "POST" });
  const authorizeUrl = new URL(((await authorization.json()) as { url: string }).url);
  if (authorizeUrl.searchParams.get("client_id") !== "52735") {
    throw new Error("The native authorization URL must use AniList development client 52735");
  }
  const oauthState = authorizeUrl.searchParams.get("state");
  if (!oauthState) {
    throw new Error("Missing native OAuth state");
  }
  const callback = new URL("tofu-dev://oauth/anilist");
  callback.hash = new URLSearchParams({ error: "access_denied", state: oauthState }).toString();
  await open(["-a", bundle, "-u", callback.href]);
  await waitFor(
    async () => (await (await request(`${base}/api/anilist`)).json()) as AniListState,
    (value) =>
      !value.authorizationPending && value.authorizationError?.includes("declined") === true
  );
  checks.push("A native AniList callback reaches the running app and validates the pending state");

  await request(`${base}/api/settings`, {
    ...json({ ...(await state()).settings, runInBackground: true }),
    method: "PUT",
  });
  await request(`${base}/api/torrents/${file.seed.infoHash}/pause`, { method: "POST" });
  await request(`${base}/api/desktop/background`, { method: "POST" });
  await waitFor(
    async () => (await (await request(`${base}/api/desktop`)).json()) as { background: boolean },
    (value) => value.background
  );
  await open(["-a", bundle, torrentPath]);
  await waitFor(
    async () => (await (await request(`${base}/api/desktop`)).json()) as { background: boolean },
    (value) => !value.background
  );
  const reopened = await state();
  if (
    reopened.torrents.length !== 2 ||
    reopened.torrents.find((torrent) => torrent.id === file.seed.infoHash)?.status !== "paused"
  ) {
    throw new Error("Reopening a torrent changed the existing library or paused state");
  }
  if (
    Bun.SHA256.hash(await Bun.file(join(downloadPath, "Native file.bin")).arrayBuffer(), "hex") !==
    Bun.SHA256.hash(file.bytes, "hex")
  ) {
    throw new Error("Reopening the torrent changed downloaded data");
  }
  checks.push("Opening an existing file restores the background window and preserves paused data");
  checks.push("The test leaves system default application preferences unchanged");
  const report = JSON.stringify({ checks, passed: true }, null, 2);
  await Bun.write(join(root, ".cache/native-opening.json"), report);
  console.log(report);
} finally {
  if (server) {
    const { pid } = server;
    process.kill(pid, "SIGTERM");
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return Promise.resolve(false);
        } catch {
          return Promise.resolve(true);
        }
      },
      (value) => value
    );
  }
  await file.close();
  await magnet.close();
  await new Promise<void>((resolve) => tracker.close(resolve));
}
