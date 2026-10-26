import type { InferOutput } from "valibot";
import {
  boolean,
  check,
  integer,
  literal,
  maxLength,
  minLength,
  minValue,
  number,
  object,
  optional,
  partial,
  pipe,
  string,
  toNumber,
  transform,
  union,
} from "valibot";
import { integerInput } from "../../lib/validation";

const bandwidthLimit = pipe(number(), integer(), minValue(-1));

export const settingsSchema = object({
  deleteTorrentFileAfterAdd: optional(boolean()),
  downloadLimit: pipe(integerInput, bandwidthLimit),
  downloadPath: pipe(string(), minLength(1), maxLength(4096)),
  moveFiles: optional(boolean()),
  runInBackground: optional(boolean()),
  seedingConnectionMode: optional(union([literal("balanced"), literal("incoming-only")])),
  theme: optional(union([literal("system"), literal("light"), literal("dark")])),
  uploadLimit: pipe(integerInput, bandwidthLimit),
});

export const settingsPatchSchema = pipe(
  partial(settingsSchema),
  check(
    (settings) => settings.moveFiles === undefined || settings.downloadPath !== undefined,
    "A download folder is required when moveFiles is provided"
  )
);

export const bandwidthInputSchema = union([
  pipe(
    literal(""),
    transform(() => -1)
  ),
  pipe(
    string(),
    toNumber(),
    minValue(0),
    transform((value) => Math.round(value * 1024)),
    bandwidthLimit
  ),
]);

export interface Settings {
  deleteTorrentFileAfterAdd: boolean;
  downloadLimit: number;
  downloadPath: string;
  runInBackground: boolean;
  seedingConnectionMode: SeedingConnectionMode;
  theme: ThemePreference;
  uploadLimit: number;
}

export type SettingsInput = InferOutput<typeof settingsPatchSchema>;

export type ThemePreference = NonNullable<SettingsInput["theme"]>;

export type SeedingConnectionMode = NonNullable<SettingsInput["seedingConnectionMode"]>;
