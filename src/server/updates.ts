import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { UpdateState } from "../types";
import { UserError } from "./engine";

const repository = "Teyik0/Tofu";
const versionPattern: RegExp = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const tokenPattern = /^[\w-]{1,4096}$/;
const versionPrefix = /^v/;
interface UpdateOptions {
  apiOrigin: string;
  arch: string;
  dataDir: string;
  notify: (version: string) => void;
  platform: string;
  version: string;
}
interface Access {
  notifiedVersion: string | null;
  token: string;
}
interface ReleaseAsset {
  id: number;
  name: string;
}
interface Release {
  assets: ReleaseAsset[];
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
}

function release(value: unknown): Release {
  if (
    !value ||
    typeof value !== "object" ||
    !("tag_name" in value) ||
    typeof value.tag_name !== "string" ||
    !("draft" in value) ||
    typeof value.draft !== "boolean" ||
    !("prerelease" in value) ||
    typeof value.prerelease !== "boolean" ||
    !("assets" in value) ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("La réponse de GitHub est invalide");
  }
  const assets = value.assets.map((asset: unknown): ReleaseAsset => {
    if (
      !asset ||
      typeof asset !== "object" ||
      !("id" in asset) ||
      typeof asset.id !== "number" ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      !("name" in asset) ||
      typeof asset.name !== "string"
    ) {
      throw new Error("La liste des installateurs est invalide");
    }
    return { id: asset.id, name: asset.name };
  });
  return { assets, draft: value.draft, prerelease: value.prerelease, tag_name: value.tag_name };
}

function versionParts(version: string) {
  const match: RegExpExecArray | null = versionPattern.exec(version);
  if (match === null) {
    throw new Error("Version de release invalide (format attendu : v1.2.3)");
  }
  return match.slice(1).map(Number);
}
function newer(candidate: string, installed: string) {
  const left = versionParts(candidate);
  const right = versionParts(installed);
  for (const index of [0, 1, 2]) {
    if (left[index] !== right[index]) {
      return (left[index] as number) > (right[index] as number);
    }
  }
  return false;
}

export class UpdatesService {
  private readonly options: UpdateOptions;
  private readonly path: string;
  private readonly access: Access;
  private asset: ReleaseAsset | null = null;
  private pending: Promise<UpdateState> | null = null;
  private mutations: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private initial: ReturnType<typeof setTimeout> | undefined;
  private readonly state: UpdateState;

  private constructor(options: UpdateOptions, access: Access) {
    this.options = options;
    this.path = join(options.dataDir, "release-access.json");
    this.access = access;
    this.state = {
      checkedAt: null,
      currentVersion: options.version,
      downloadName: null,
      error: null,
      hasToken: Boolean(access.token),
      latestVersion: null,
      releaseUrl: null,
      status: access.token ? "idle" : "auth-required",
    };
  }
  static async open(options: UpdateOptions) {
    await mkdir(options.dataDir, { recursive: true });
    const file = Bun.file(join(options.dataDir, "release-access.json"));
    const saved: unknown = (await file.exists()) ? await file.json() : null;
    const access: Access = { notifiedVersion: null, token: "" };
    if (saved && typeof saved === "object" && "token" in saved && typeof saved.token === "string") {
      access.token = saved.token;
      if ("notifiedVersion" in saved && typeof saved.notifiedVersion === "string") {
        access.notifiedVersion = saved.notifiedVersion;
      }
      await chmod(file.name as string, 0o600);
    }
    return new UpdatesService(options, access);
  }
  snapshot(): UpdateState {
    return { ...this.state };
  }
  start() {
    if (this.timer) {
      return;
    }
    this.initial = setTimeout(() => {
      void this.check();
    }, 10_000);
    this.initial.unref();
    this.timer = setInterval(
      () => {
        void this.check();
      },
      6 * 60 * 60 * 1000
    );
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    clearTimeout(this.initial);
    this.timer = undefined;
  }
  private async persist() {
    const temporary = `${this.path}.tmp`;
    await Bun.write(temporary, JSON.stringify(this.access), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(action);
    this.mutations = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
  configure(input: { token?: string; clearToken?: boolean }) {
    return this.serial(() => this.configureAccess(input));
  }
  private async configureAccess(input: { token?: string; clearToken?: boolean }) {
    if (input.clearToken) {
      this.access.token = "";
    } else if (input.token !== undefined) {
      if (!tokenPattern.test(input.token)) {
        throw new UserError("Jeton GitHub invalide", { status: 400 });
      }
      this.access.token = input.token;
    }
    this.asset = null;
    Object.assign(this.state, {
      downloadName: null,
      error: null,
      hasToken: Boolean(this.access.token),
      latestVersion: null,
      releaseUrl: null,
      status: this.access.token ? "idle" : "auth-required",
    });
    await this.persist();
    return this.snapshot();
  }
  private github(path: string, accept: string) {
    return fetch(`${this.options.apiOrigin}/repos/${repository}${path}`, {
      headers: {
        accept,
        authorization: `Bearer ${this.access.token}`,
        "user-agent": `Tofu/${this.options.version}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  }
  check(): Promise<UpdateState> {
    this.pending ??= this.serial(() => this.readLatest()).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async readLatest() {
    this.asset = null;
    Object.assign(this.state, {
      downloadName: null,
      error: null,
      latestVersion: null,
      releaseUrl: null,
      status: this.access.token ? "checking" : "auth-required",
    });
    if (!this.access.token) {
      return this.snapshot();
    }
    try {
      const response = await this.github("/releases/latest", "application/vnd.github+json");
      this.state.checkedAt = Date.now();
      if (response.status === 401 || response.status === 403) {
        throw new UserError(
          "Le jeton GitHub est expiré ou ne permet pas de lire les releases privées",
          { status: 401 }
        );
      }
      if (response.status === 404) {
        const repo = await this.github("", "application/vnd.github+json");
        if (!repo.ok) {
          throw new UserError(
            "Ce jeton n’a pas accès au dépôt privé Teyik0/Tofu (permission Contents : lecture)",
            { status: 401 }
          );
        }
        this.state.status = "no-release";
        return this.snapshot();
      }
      if (!response.ok) {
        throw new Error(`GitHub est indisponible (HTTP ${response.status})`);
      }
      const latest = release(await response.json());
      if (latest.draft || latest.prerelease) {
        throw new Error("Aucune release stable disponible");
      }
      const version = latest.tag_name.replace(versionPrefix, "");
      versionParts(version);
      this.state.latestVersion = version;
      this.state.releaseUrl = `https://github.com/${repository}/releases/tag/v${version}`;
      if (!newer(version, this.options.version)) {
        this.state.status = "current";
        return this.snapshot();
      }
      const name = `Tofu-${version}-macos-${this.options.arch}.dmg`;
      this.asset =
        latest.assets.find((item) => item.name === name && this.options.platform === "darwin") ??
        null;
      if (!this.asset) {
        throw new Error("Aucun installateur compatible avec cette machine dans la release");
      }
      this.state.downloadName = this.asset.name;
      this.state.status = "available";
      if (this.access.notifiedVersion !== version) {
        this.options.notify(version);
        this.access.notifiedVersion = version;
        await this.persist();
      }
    } catch (error) {
      this.state.status =
        error instanceof UserError && error.status === 401 ? "auth-required" : "error";
      this.state.error = error instanceof Error ? error.message : "Vérification impossible";
    }
    return this.snapshot();
  }
  async download() {
    if (!(this.access.token && this.asset) || this.state.status !== "available") {
      throw new UserError("Vérifiez les mises à jour avant de télécharger l’installateur", {
        status: 409,
      });
    }
    const { asset } = this;
    let response = await this.github(`/releases/assets/${asset.id}`, "application/octet-stream");
    if ([401, 403, 404].includes(response.status)) {
      this.asset = null;
      this.state.downloadName = null;
      this.state.status = "auth-required";
      this.state.error =
        "L’accès à cette release privée a expiré ou a été révoqué. Vérifiez votre jeton GitHub.";
      throw new UserError(this.state.error, { status: 401 });
    }
    if (response.status === 302) {
      const location = response.headers.get("location");
      const target = location ? new URL(location) : null;
      if (
        target?.protocol !== "https:" ||
        !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
          target.hostname
        )
      ) {
        throw new UserError("GitHub a renvoyé une adresse de téléchargement invalide", {
          status: 502,
        });
      }
      // The signed asset URL needs no GitHub credential; never forward the bearer token.
      response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(120_000) });
    }
    if (!response.ok) {
      throw new UserError(`Téléchargement indisponible (HTTP ${response.status})`, { status: 502 });
    }
    return new Response(response.body, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${asset.name}"`,
        "content-type": "application/octet-stream",
      },
    });
  }
}
