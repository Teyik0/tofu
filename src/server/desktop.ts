import { join } from "node:path";
import { type DesktopBackend, getExternalUrl } from "@teyik0/furin-electrobun/host";
import type { BrowserWindow, Tray as NativeTray } from "electrobun/main";
import type { DesktopState, InstanceProfile } from "../types";
import { DesktopUpdateInstaller } from "./desktop-update-installer";
import { type TorrentEngine, UserError } from "./engine";

export class DesktopController {
  private window: BrowserWindow | null = null;
  private readonly sdk: typeof import("electrobun/main");
  private readonly tray: NativeTray;
  private readonly url: string;
  private readonly backend: DesktopBackend;
  private readonly engine: () => TorrentEngine;
  private readonly smokeScript: string | null;
  private readonly name: string;
  private quitting = false;
  private installing = false;
  private readonly updateInstaller: DesktopUpdateInstaller;

  constructor(options: {
    sdk: typeof import("electrobun/main");
    backend: DesktopBackend;
    engine: () => TorrentEngine;
    smokeScript: string | null;
    name: string;
    profile: InstanceProfile;
    publicDir: string;
    checkUpdates: () => Promise<unknown>;
    shutdown: () => Promise<void>;
    prepareUpdate: () => Promise<void>;
    recover: () => Promise<void>;
  }) {
    this.sdk = options.sdk;
    const { default: Electrobun, Tray, Utils } = this.sdk;
    this.updateInstaller = new DesktopUpdateInstaller({
      allowQuit: (allowed) => {
        this.quitting = allowed;
      },
      recover: options.recover,
      shutdown: options.prepareUpdate,
      updater: this.sdk.Updater,
    });
    this.backend = options.backend;
    this.url = options.backend.origin;
    this.engine = options.engine;
    this.smokeScript = options.smokeScript;
    this.name = options.name;
    this.tray = new Tray({
      height: 18,
      image: join(
        options.publicDir,
        process.platform === "darwin" ? "tray-template.png" : "icon.png"
      ),
      template: process.platform === "darwin",
      title: options.profile === "dev" ? "DEV" : "",
      width: 18,
    });
    this.tray.setMenu([
      { action: "open-native", label: `Open ${this.name}`, type: "normal" },
      { action: "open-web", label: "Open in browser", type: "normal" },
      { type: "divider" },
      { action: "check-updates", label: "Check for updates", type: "normal" },
      { type: "divider" },
      { action: "quit", label: `Quit ${this.name}`, type: "normal" },
    ]);
    this.tray.on("tray-clicked", (event) => {
      const { action } = (event as { data: { action: string } }).data;
      if (action === "open-native") {
        this.open();
      } else if (action === "open-web") {
        Utils.openExternal(this.backend.createWindowUrl());
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
      // biome-ignore lint/suspicious/noUnnecessaryConditions: an update request mutates these flags before native quit callbacks.
      if (this.installing && !this.quitting) {
        event.response = { allow: false };
        return;
      }
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
      throw new UserError("Tofu is shutting down", { status: 409 });
    }
    if (this.window) {
      this.window.show();
      this.window.activate();
      return this.snapshot();
    }
    const window = new this.sdk.BrowserWindow({
      allowedProtocols: { appData: false, views: false },
      frame: { height: 940, width: 1400, x: 120, y: 80 },
      navigationRules: JSON.stringify(["^*", `${this.url}/*`, `${this.backend.bootstrapOrigin}/*`]),
      renderer: "native",
      sandbox: true,
      title: this.name,
      url: this.backend.createWindowUrl(),
    });
    this.window = window;
    window.show();
    window.activate();
    window.on("close", () => {
      this.window = null;
      if (!(this.engine().settings.runInBackground && this.tray.visible)) {
        this.sdk.Utils.quit(0);
      }
    });
    const script = this.smokeScript;
    const external = (event: { data: { detail: string | { url: string } } }) => {
      const url = getExternalUrl(event.data.detail, [this.url, this.backend.bootstrapOrigin]);
      if (url) {
        this.sdk.Utils.openExternal(url);
      }
    };
    this.sdk.default.events.on(`will-navigate-${window.webviewId}`, external);
    this.sdk.default.events.on(`new-window-open-${window.webviewId}`, external);
    if (script) {
      window.webview.on("dom-ready", () => window.webview.executeJavascript(script));
    }
    return this.snapshot();
  }
  background() {
    if (!this.engine().settings.runInBackground) {
      throw new UserError("Enable Run in background in settings first", {
        status: 409,
      });
    }
    if (!this.snapshot().trayVisible) {
      throw new UserError("The menu bar icon is unavailable; the window stays open", {
        status: 503,
      });
    }
    // Let the HTTP response reach the WebView before releasing its native window.
    setTimeout(() => this.window?.requestClose(), 100);
    return { ok: true };
  }
  openDownload() {
    return {
      opened: this.sdk.Utils.openExternal(this.backend.createWindowUrl("/api/updates/download")),
    };
  }
  async installUpdate() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: concurrent update and native quit requests mutate these flags.
    if (this.installing || this.quitting) {
      throw new UserError("Tofu is already shutting down", { status: 409 });
    }
    this.installing = true;
    try {
      await this.updateInstaller.install();
    } finally {
      this.installing = false;
    }
  }
}
