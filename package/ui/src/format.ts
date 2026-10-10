import type { TorrentStatus } from "@tofu/plugins/domain";

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
export function bytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  if (value === 0) {
    return "0 B";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(
    Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)),
    units.length - 1
  );
  return `${(value / 1024 ** index).toLocaleString("en-US", { maximumFractionDigits: index > 1 ? 2 : 0 })} ${units[index]}`;
}
export function speed(value: number) {
  return `${bytes(Math.max(0, value))}/s`;
}
export function percent(value: number) {
  return `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })} %`;
}
export function duration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "—";
  }
  if (seconds < 1) {
    return "0 s";
  }
  if (seconds < 60) {
    return `${Math.ceil(seconds)} s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)} s`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  }
  return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3600)} h`;
}
export function date(value: number | null) {
  return value ? dateFormatter.format(value) : "—";
}
export function ratio(value: number | null) {
  return value === null
    ? "—"
    : value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}
export const statusLabels: { [Status in TorrentStatus]: string } = {
  checking: "Verification",
  downloading: "Downloading",
  error: "Error",
  idle: "Waiting for peers",
  metadata: "Metadata",
  moving: "Moving",
  paused: "Paused",
  seeding: "Seeding",
};
const relativeFormatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
/** "in 12 minutes", "3 hours ago"; null stays "—". */
export function relative(value: number | null, now: number) {
  if (value === null) {
    return "—";
  }
  const seconds = (value - now) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return relativeFormatter.format(Math.round(seconds / size), unit);
    }
  }
  return seconds >= 0 ? "in less than a minute" : "just now";
}
