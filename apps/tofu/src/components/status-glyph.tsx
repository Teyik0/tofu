import type { TorrentStatus } from "../types";
import { Icon, type IconName } from "./icon";

const glyphs: { [Status in TorrentStatus]: IconName } = {
  checking: "shield",
  downloading: "download",
  error: "alert",
  idle: "clock",
  metadata: "info",
  moving: "folder",
  paused: "pause",
  seeding: "upload",
};

/** A status icon wrapped in a ring that fills with the torrent's verified progress. */
export function StatusGlyph({
  status,
  progress,
  size,
}: {
  status: TorrentStatus;
  progress: number;
  size: number;
}) {
  const radius = size / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="status-glyph" data-status={status} style={{ height: size, width: size }}>
      <svg aria-hidden="true" height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
        <circle className="status-glyph-track" cx={size / 2} cy={size / 2} r={radius} />
        <circle
          className="status-glyph-value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, progress)))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <Icon name={glyphs[status]} size={Math.round(size * 0.42)} />
    </span>
  );
}
