import { join } from "node:path";
import type { DesktopTarget, InstanceProfile } from "./types";

export const releaseTargets: DesktopTarget[] = [
  { arch: "arm64", platform: "macos" },
  { arch: "x64", platform: "win" },
  { arch: "x64", platform: "linux" },
  { arch: "arm64", platform: "linux" },
];

export function desktopTarget(platform: string, arch: string): DesktopTarget | null {
  let name = platform;
  if (platform === "darwin") {
    name = "macos";
  } else if (platform === "win32") {
    name = "win";
  }
  return releaseTargets.find((target) => target.platform === name && target.arch === arch) ?? null;
}

export function installerName(version: string, target: DesktopTarget) {
  const extension = installerExtension(target);
  return `Tofu-${version}-${target.platform}-${target.arch}.${extension}`;
}

export function installerExtension(target: DesktopTarget) {
  const extensions = { linux: "tar.gz", macos: "dmg", win: "zip" } as const;
  return extensions[target.platform];
}

export function desktopLauncher(root: string, target: DesktopTarget, profile: InstanceProfile) {
  const channel = profile === "dev" ? "dev" : "stable";
  const name = profile === "dev" ? "Tofu-dev" : "Tofu";
  const directory = join(
    root,
    `.furin/electrobun/build/${channel}-${target.platform}-${target.arch}`
  );
  return target.platform === "macos"
    ? join(directory, `${name}.app/Contents/MacOS/launcher`)
    : join(directory, name, "bin", target.platform === "win" ? "launcher.exe" : "launcher");
}

export function hostDesktopTarget() {
  const target = desktopTarget(process.platform, process.arch);
  if (!target) {
    throw new Error(`Unsupported desktop target: ${process.platform}/${process.arch}`);
  }
  return target;
}
