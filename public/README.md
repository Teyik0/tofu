# Tofu icon

`tofu-logo-source.png` preserves the supplied 1024 × 1024 image: a smiling tofu cube, a download arrow, and the Tofu name in olive and ivory.

`tofu-icon.png` is the version used by the application. `tofu-icon-mask.svg` replaces the white exterior with transparency using a geometric mask slightly inside the green outline. The mask is rendered at four times the resolution and downsampled to smooth the edges without white fringes. The artwork’s colors and ivory tofu remain intact and opaque. This deterministic cutout preserves the supplied artwork; regenerating the logo could alter it.

`tofu.iconset/` contains the ten macOS sizes exported with `sips`. Electrobun converts this iconset to `AppIcon.icns` during the build through `build.mac.icons`.

The interface and PNG favicon use `public/icon.png` (256 × 256). `public/apple-touch-icon.png` (180 × 180) and `public/favicon.ico` (16, 32, and 48 pixels) use the same image.

`public/tray-template.png` is a monochrome version of the emblem, without the name or background, on a transparent 36 × 36 canvas. Electrobun displays it at 18 × 18 with `template: true` so macOS adapts its color to the menu bar.

To regenerate the cutout, ten macOS sizes, favicons, and tray template from the source on macOS with ImageMagick installed:

```sh
bun scripts/icons.ts
```

PNGs are exported with `sips`; the ICO and tray template use ImageMagick. These tools are only needed to regenerate the assets, not to launch or build the application.

The `tofu-swarm-proposal.*` and `tofu-torrent-proposal.*` files are historical proposals and are not used by the application.
