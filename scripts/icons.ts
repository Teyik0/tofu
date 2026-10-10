import { join } from "node:path";

const root = join(import.meta.dir, "..");

async function convert(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stderr: "inherit", stdout: "ignore" });
  if ((await child.exited) !== 0) {
    throw new Error(`Icon conversion failed: ${args.join(" ")}`);
  }
}

// Render the inset mask at 4× resolution for a smooth alpha edge without white fringes.
await convert([
  "magick",
  "public/tofu-logo-source.png",
  "(",
  "public/tofu-icon-mask.svg",
  "-filter",
  "box",
  "-resize",
  "1024x1024",
  "-alpha",
  "off",
  "-colorspace",
  "gray",
  ")",
  "-alpha",
  "off",
  "-compose",
  "CopyOpacity",
  "-composite",
  "public/tofu-icon.png",
]);

const exports = [
  ["public/tofu.iconset/icon_16x16.png", 16],
  ["public/tofu.iconset/icon_16x16@2x.png", 32],
  ["public/tofu.iconset/icon_32x32.png", 32],
  ["public/tofu.iconset/icon_32x32@2x.png", 64],
  ["public/tofu.iconset/icon_128x128.png", 128],
  ["public/tofu.iconset/icon_128x128@2x.png", 256],
  ["public/tofu.iconset/icon_256x256.png", 256],
  ["public/tofu.iconset/icon_256x256@2x.png", 512],
  ["public/tofu.iconset/icon_512x512.png", 512],
  ["public/tofu.iconset/icon_512x512@2x.png", 1024],
  ["public/icon.png", 256],
  ["public/apple-touch-icon.png", 180],
] as const;
await Promise.all(
  exports.map(([path, size]) =>
    convert(["sips", "-z", String(size), String(size), "public/tofu-icon.png", "--out", path])
  )
);

await convert([
  "magick",
  "public/tofu-icon.png",
  "-define",
  "icon:auto-resize=48,32,16",
  "public/favicon.ico",
]);
await convert([
  "magick",
  "public/tofu-logo-source.png",
  "-crop",
  "650x550+186+151",
  "+repage",
  "-colorspace",
  "gray",
  "-threshold",
  "60%",
  "-negate",
  "-resize",
  "36x36",
  "-gravity",
  "center",
  "-background",
  "black",
  "-extent",
  "36x36",
  "-alpha",
  "copy",
  "-channel",
  "RGB",
  "-evaluate",
  "set",
  "0",
  "+channel",
  "public/tray-template.png",
]);
