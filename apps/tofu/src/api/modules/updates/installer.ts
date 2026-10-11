import type { Updater } from "electrobun/main";

interface InstallerOptions {
  allowQuit: (allowed: boolean) => void;
  recover: () => Promise<void>;
  shutdown: () => Promise<void>;
  updater: Pick<typeof Updater, "applyUpdate" | "updateInfo" | "getStatusHistory">;
}

/** Native replacement must run after torrent persistence, with the usual quit veto lifted. */
export class DesktopUpdateInstaller {
  private readonly options: InstallerOptions;

  constructor(options: InstallerOptions) {
    this.options = options;
  }

  async install() {
    const { allowQuit, shutdown, recover, updater } = this.options;
    try {
      await shutdown();
      allowQuit(true);
      await updater.applyUpdate();
      // Electrobun reports helper failures through updateInfo instead of rejecting.
      const info = updater.updateInfo();
      if (info.error) {
        throw new Error(info.error);
      }
      if (updater.getStatusHistory().at(-1)?.status !== "launching-new-version") {
        throw new Error("The update restart was cancelled. Try again.");
      }
    } catch (error) {
      allowQuit(false);
      await recover();
      throw error;
    }
  }
}
