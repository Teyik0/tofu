import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { InstanceConfig, InstanceProfile, ServerInfo } from "../types";

const invalidDesktopPath = /[\r\n\0]/;
const invalidWindowsPath = /["\r\n\0]/;
const reservedDesktopCharacters = /[\\"`$]/g;

export async function forwardNativeAuthorization(options: {
  dataDir: string;
  profile: InstanceProfile;
  url: string;
}) {
  const callback = new URL(options.url);
  const scheme = options.profile === "release" ? "tofu:" : "tofu-dev:";
  if (
    callback.protocol !== scheme ||
    callback.hostname !== "oauth" ||
    callback.pathname !== "/anilist" ||
    callback.username ||
    callback.password ||
    callback.port ||
    callback.search
  ) {
    throw new Error("Invalid AniList callback");
  }
  const file = Bun.file(join(options.dataDir, "server.json"));
  if (!(await file.exists())) {
    return false;
  }
  const descriptor = (await file.json()) as ServerInfo;
  const address = new URL(descriptor.url);
  if (
    descriptor.mode !== "desktop" ||
    descriptor.profile !== options.profile ||
    address.protocol !== "http:" ||
    address.hostname !== "127.0.0.1" ||
    address.username ||
    address.password ||
    address.pathname !== "/" ||
    address.search ||
    address.hash
  ) {
    throw new Error("The protocol handler does not match the running Tofu instance");
  }
  let response: Response;
  try {
    response = await fetch(new URL("/api/instance", address), {
      headers: descriptor.cookie ? { cookie: descriptor.cookie } : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return false;
  }
  const instance = (await response.json()) as { profile: string; dataDir: string };
  if (
    !response.ok ||
    instance.profile !== options.profile ||
    instance.dataDir !== options.dataDir
  ) {
    throw new Error("The protocol handler does not match the running Tofu instance");
  }
  const result = await fetch(new URL("/api/anilist/callback", address), {
    body: JSON.stringify({ url: options.url }),
    headers: {
      "content-type": "application/json",
      ...(descriptor.cookie ? { cookie: descriptor.cookie } : {}),
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  // Bring the existing window forward even when authorization expired.
  await fetch(new URL("/api/desktop/open", address), {
    headers: descriptor.cookie ? { cookie: descriptor.cookie } : undefined,
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  if (!result.ok) {
    throw new Error("AniList authorization failed or expired. Connect again from Tofu.");
  }
  return true;
}

async function command(args: string[]) {
  const child = Bun.spawn(args, { stderr: "ignore", stdout: "ignore" });
  if ((await child.exited) !== 0) {
    throw new Error("Unable to register the Tofu OAuth protocol");
  }
}

function desktopArgument(value: string) {
  if (invalidDesktopPath.test(value)) {
    throw new Error("Invalid protocol handler path");
  }
  return `"${value
    .replaceAll("%", "%%")
    .replace(reservedDesktopCharacters, (character) => `\\${character}`)
    .replaceAll("\\", "\\\\")}"`;
}

/** Electrobun registers macOS schemes; other platforms need a per-user handler. */
export async function registerDesktopProtocol(instance: InstanceConfig) {
  if (process.platform === "darwin") {
    return;
  }
  const helper = join(dirname(process.execPath), "../Resources/app/bun/desktop-protocol.js");
  if (!(await Bun.file(helper).exists())) {
    throw new Error("The packaged protocol helper is missing");
  }
  const scheme = instance.profile === "release" ? "tofu" : "tofu-dev";
  const args = [process.execPath, helper, instance.dataDir];
  if (process.platform === "win32") {
    const key = `HKCU\\Software\\Classes\\${scheme}`;
    const quoted = args
      .map((arg) => {
        if (invalidWindowsPath.test(arg)) {
          throw new Error("Invalid protocol handler path");
        }
        return `"${arg}"`;
      })
      .join(" ");
    await command(["reg.exe", "add", key, "/ve", "/d", `URL:${instance.name} OAuth`, "/f"]);
    await command(["reg.exe", "add", key, "/v", "URL Protocol", "/d", "", "/f"]);
    await command([
      "reg.exe",
      "add",
      `${key}\\shell\\open\\command`,
      "/ve",
      "/d",
      `${quoted} "%1"`,
      "/f",
    ]);
    return;
  }
  const applications = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
    "applications"
  );
  await mkdir(applications, { recursive: true });
  const name = `${instance.identifier}.oauth.desktop`;
  await Bun.write(
    join(applications, name),
    `[Desktop Entry]\nType=Application\nName=${instance.name} OAuth\nNoDisplay=true\nExec=${args.map(desktopArgument).join(" ")} %u\nMimeType=x-scheme-handler/${scheme};\n`
  );
  await command(["xdg-mime", "default", name, `x-scheme-handler/${scheme}`]);
}
