import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const homeDir = homedir();
const development = process.env.NODE_ENV !== "production";
const stateRoot = getStateRoot();
const dataDir = resolve(process.env.FURIN_APP_DATA_DIR ?? join(stateRoot, development ? "Tofu-dev" : "Tofu"))

function getStateRoot() {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? join(homeDir, "AppData/Roaming");
  }
  if (process.platform === "darwin") {
    return join(homeDir, "Library/Application Support");
  }
  if (process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)) {
    return process.env.XDG_DATA_HOME;
  }
  return join(homeDir, ".local/share");
}

export const instance = {
  dataDir,
  desktop: Boolean(process.env.FURIN_APP_DATA_DIR),
  defaultDownloadPath: join(homeDir, "Downloads", "Tofu"),
  identifier: development ? "app.tofu.torrents.dev" : "app.tofu.torrents",
  name: development ? "Tofu Dev" : "Tofu",
  profile: (development ? "dev" : "release"),
  port: development ? 3030 : 3031,
  logDirectory: join(dataDir, "logs")
} as const;
