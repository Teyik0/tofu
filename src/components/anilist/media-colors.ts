import type { CSSProperties } from "react";

type RGB = readonly [number, number, number];
interface MediaColors extends CSSProperties {
  "--anime-media-background": string;
  "--anime-media-background-text": string;
  "--anime-media-text-dark": string;
  "--anime-media-text-light": string;
}

// AniList matches the API's average cover color to this badge palette in RGB space.
const hexColor = /^#[\da-f]{6}$/i;
const palette = [
  ["#ef5c5c", "#fff4f7"],
  ["#fd364e", "#ffebeb"],
  ["#c6223f", "#fff1f2"],
  ["#faa9ca", "#6b2542"],
  ["#e34f85", "#ffe2ed"],
  ["#cdb9f1", "#3c1179"],
  ["#9262e9", "#ebdefe"],
  ["#7600cc", "#e0cfff"],
  ["#9db9ff", "#282a7b"],
  ["#4e60b6", "#dee3ff"],
  ["#2f368b", "#d9e4ff"],
  ["#bee3f9", "#273a4b"],
  ["#6dc8f1", "#1c4a75"],
  ["#3682ea", "#f2f9fd"],
  ["#14409d", "#def0ff"],
  ["#76f3e9", "#1b606d"],
  ["#01c4d7", "#effdff"],
  ["#194d71", "#d3edfc"],
  ["#94ffa9", "#25642e"],
  ["#9be53d", "#255414"],
  ["#267f19", "#f0f8e8"],
  ["#fff27e", "#ae4e18"],
  ["#ecb62c", "#882b0f"],
  ["#882b0f", "#fef4c4"],
  ["#e1d6a0", "#4c4023"],
  ["#f2870d", "#5e2b0c"],
  ["#f35428", "#ffe8e0"],
] as const satisfies readonly (readonly [string, string])[];

function rgb(hex: string): RGB {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}
function lightness(color: RGB) {
  return Math.max(...color) + Math.min(...color);
}
function hue([red, green, blue]: RGB) {
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  if (delta === 0) {
    return 0;
  }
  const sector =
    max === red
      ? (green - blue) / delta
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return Math.round((sector * 60 + 360) % 360);
}
function cssHsl(color: RGB) {
  const max = Math.max(...color) / 255;
  const min = Math.min(...color) / 255;
  const light = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
  // AniList rounds all HSL channels before emitting CSS, including badge colors.
  return `hsl(${hue(color)},${Math.round(saturation * 100)}%,${Math.round(light * 100)}%)`;
}

const defaultColors: MediaColors = {
  "--anime-media-background": "hsl(202,57%,89%)",
  "--anime-media-background-text": "hsl(202,57%,25%)",
  "--anime-media-text-dark": "hsl(202,57%,40%)",
  "--anime-media-text-light": "hsl(202,57%,40%)",
};

export function aniListMediaColors(coverColor: string | null | undefined): MediaColors {
  if (!(coverColor && hexColor.test(coverColor))) {
    return defaultColors;
  }
  const [red, green, blue] = rgb(coverColor);
  let closest: readonly [string, string] = palette[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const pair of palette) {
    const [backgroundRed, backgroundGreen, backgroundBlue] = rgb(pair[0]);
    const candidate =
      (red - backgroundRed) ** 2 + (green - backgroundGreen) ** 2 + (blue - backgroundBlue) ** 2;
    if (candidate < distance) {
      closest = pair;
      distance = candidate;
    }
  }
  const [background, text] = closest;
  return {
    "--anime-media-background": cssHsl(rgb(background)),
    "--anime-media-background-text": cssHsl(rgb(text)),
    "--anime-media-text-dark": `hsl(${hue(rgb(text))},80%,70%)`,
    "--anime-media-text-light": cssHsl(
      rgb(lightness(rgb(background)) > lightness(rgb(text)) ? text : background)
    ),
  };
}
