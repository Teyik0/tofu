import type { Settings, SettingsInput } from "../../../../../../package/plugins/src/settings-model";

/** Host paths, native background mode and deleting source files are changed by the owner only. */
export function changesOwnerSettings(current: Settings, input: SettingsInput) {
  return (
    (input.downloadPath !== undefined && input.downloadPath !== current.downloadPath) ||
    (input.runInBackground !== undefined && input.runInBackground !== current.runInBackground) ||
    (input.deleteTorrentFileAfterAdd !== undefined &&
      input.deleteTorrentFileAfterAdd !== current.deleteTorrentFileAfterAdd)
  );
}
