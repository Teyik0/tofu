// biome-ignore-all lint/suspicious/noArrayIndexKey: piece-map bins have fixed positions and no component state.

import { speed } from "@tofu/ui/format";
import { memo, useId } from "react";
import type { SpeedSample } from "../types";
export const TrafficChart = memo(function TrafficChartView({
  samples,
  small,
}: {
  samples: SpeedSample[];
  small: boolean;
}) {
  const id = useId();
  const maximum = Math.max(1024, ...samples.flatMap((sample) => [sample.download, sample.upload]));
  const coordinates = (key: "download" | "upload") =>
    samples.map(
      (sample, index) =>
        `${(index / Math.max(1, samples.length - 1)) * 600},${96 - (sample[key] / maximum) * 84}`
    );
  const line = (key: "download" | "upload") => coordinates(key).join(" ");
  const area = (key: "download" | "upload") =>
    samples.length > 1 ? `M0,96 L${coordinates(key).join(" L")} L600,96 Z` : "";
  return (
    <div className={small ? "sparkline" : "traffic-chart"}>
      {!small && (
        <div className="chart-scale">
          <span>{speed(maximum)}</span>
          <span>{speed(maximum / 2)}</span>
          <span>0 B/s</span>
        </div>
      )}
      <svg
        aria-label="Actual download and upload speed history"
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 600 100"
      >
        <defs>
          {(["download", "upload"] as const).map((key) => (
            <linearGradient id={`${id}-${key}`} key={key} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={`var(--chart-${key})`} stopOpacity={0.28} />
              <stop offset="100%" stopColor={`var(--chart-${key})`} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <path
          className="chart-grid"
          d="M0 12H600 M0 54H600 M0 96H600"
          fill="none"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
        />
        <path d={area("upload")} fill={`url(#${id}-upload)`} />
        <path d={area("download")} fill={`url(#${id}-download)`} />
        <polyline
          fill="none"
          points={line("upload")}
          stroke="var(--chart-upload)"
          strokeLinejoin="round"
          strokeWidth={small ? 2 : 1.75}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          fill="none"
          points={line("download")}
          stroke="var(--chart-download)"
          strokeLinejoin="round"
          strokeWidth={small ? 2 : 1.75}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
});
