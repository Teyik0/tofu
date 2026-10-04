import { join } from "node:path";
import type { BrowserWindow, Tray as NativeTray } from "electrobun/main";
import type { DesktopState } from "../types";
import { type TorrentEngine, UserError } from "./engine";

export class DesktopController {
  private window: BrowserWindow | null = null;
  private readonly sdk: typeof import("electrobun/main");
  private readonly tray: NativeTray;
  private readonly url: string;
  private readonly engine: () => TorrentEngine;
  private readonly smokeScript: string | null;
  private quitting = false;

  constructor(options: {
    sdk: typeof import("electrobun/main");
    url: string;
    engine: () => TorrentEngine;
    smokeScript: string | null;
    checkUpdates: () => Promise<unknown>;
    shutdown: () => Promise<void>;
  }) {
    this.sdk = options.sdk;
    const { default: Electrobun, Tray, Utils } = this.sdk;
    this.url = options.url;
    this.engine = options.engine;
    this.smokeScript = options.smokeScript;
    this.tray = new Tray({
      height: 18,
      image: join(import.meta.dir, "public/tray-template.png"),
      template: true,
      width: 18,
    });
    this.tray.setMenu([
      { action: "open-native", label: "Ouvrir Tofu", type: "normal" },
      { action: "open-web", label: "Ouvrir dans le navigateur", type: "normal" },
      { type: "divider" },
      { action: "check-updates", label: "Rechercher une mise à jour", type: "normal" },
      { type: "divider" },
      { action: "quit", label: "Quitter Tofu", type: "normal" },
    ]);
    this.tray.on("tray-clicked", (event) => {
      const { action } = (event as { data: { action: string } }).data;
      if (action === "open-native") {
        this.open();
      } else if (action === "open-web") {
        Utils.openExternal(this.url);
      } else if (action === "check-updates") {
        void options
          .checkUpdates()
          .then(() => this.open())
          .catch(console.error);
      } else if (action === "quit") {
        this.sdk.Utils.quit(0);
      }
    });
    Electrobun.events.on("reopen", () => this.open());
    Electrobun.events.on("before-quit", (event: { response: { allow: boolean } | undefined }) => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: native callbacks mutate this flag between quit events.
      if (this.quitting) {
        return;
      }
      event.response = { allow: false };
      this.quitting = true;
      void options
        .shutdown()
        .then(() => {
          this.tray.remove();
          Utils.quit(0);
        })
        .catch((error) => {
          console.error(error);
          Utils.quit(1);
        });
    });
    this.open();
  }
  snapshot(): DesktopState {
    return {
      background: this.window === null,
      trayVisible: this.tray.visible,
      webviews: this.sdk.BrowserView.getAll().length,
      windows: this.window ? 1 : 0,
    };
  }
  open() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the native before-quit callback sets this flag asynchronously.
    if (this.quitting) {
      throw new UserError("Tofu est en cours de fermeture", { status: 409 });
    }
    if (this.window) {
      this.window.show();
      this.window.activate();
      return this.snapshot();
    }
    const window = new this.sdk.BrowserWindow({
      frame: { height: 940, width: 1400, x: 120, y: 80 },
      renderer: "native",
      sandbox: true,
      title: "Tofu",
      url: this.url,
    });
    this.window = window;
    window.on("close", () => {
      this.window = null;
      if (!(this.engine().settings.runInBackground && this.tray.visible)) {
        this.sdk.Utils.quit(0);
      }
    });
    const script = this.smokeScript;
    if (script) {
      window.webview.on("dom-ready", () => window.webview.executeJavascript(script));
    }
    return this.snapshot();
  }
  background() {
    if (!this.engine().settings.runInBackground) {
      throw new UserError("Activez d’abord l’option Tourner en arrière-plan dans les paramètres", {
        status: 409,
      });
    }
    if (!this.snapshot().trayVisible) {
      throw new UserError(
        "L’icône de la barre de menus est indisponible ; la fenêtre reste ouverte",
        { status: 503 }
      );
    }
    // Let the HTTP response reach the WebView before releasing its native window.
    setTimeout(() => this.window?.requestClose(), 100);
    return { ok: true };
  }
  openDownload() {
    return { opened: this.sdk.Utils.openExternal(`${this.url}/api/updates/download`) };
  }
}
