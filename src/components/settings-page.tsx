import { useRouter } from "@teyik0/furin/link";
import {
  ArrowLeftIcon,
  DownloadIcon,
  FolderIcon,
  LoaderCircleIcon,
  PaletteIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { applyTheme } from "../theme";
import type { Settings, ThemePreference } from "../types";
import { request } from "./api";
import { useDashboard } from "./app-shell";
import { Logo } from "./icon";
import { OptionSelect } from "./option-select";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./ui/field";
import { Input } from "./ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./ui/input-group";
import { Switch } from "./ui/switch";
import { SidebarUpdateAction, UpdatesPanel } from "./updates";

const themeOptions = [
  { label: "System (default)", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] satisfies { label: string; value: ThemePreference }[];
type Section = "general" | "appearance" | "downloads" | "updates";
const sections = [
  { icon: SlidersHorizontalIcon, id: "general", label: "General" },
  { icon: PaletteIcon, id: "appearance", label: "Appearance" },
  { icon: DownloadIcon, id: "downloads", label: "Downloads" },
  { icon: RefreshCwIcon, id: "updates", label: "Updates" },
] satisfies { id: Section; label: string; icon: typeof SlidersHorizontalIcon }[];

export function SettingsPage() {
  const { data, refresh, settingsBackPath } = useDashboard();
  const router = useRouter();
  const [section, setSection] = useState<Section>("general");
  useEffect(() => {
    if (window.location.hash === "#updates") {
      setSection("updates");
    }
  }, []);
  const [path, setPath] = useState(data.settings.downloadPath);
  const [theme, setTheme] = useState<ThemePreference>(data.settings.theme);
  const [down, setDown] = useState(
    data.settings.downloadLimit === -1 ? "" : String(data.settings.downloadLimit / 1024)
  );
  const [up, setUp] = useState(
    data.settings.uploadLimit === -1 ? "" : String(data.settings.uploadLimit / 1024)
  );
  const [runInBackground, setRunInBackground] = useState(data.settings.runInBackground);
  const [moveFiles, setMoveFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const torrents = data.torrents.filter((torrent) => torrent.destinationId === "default");
  const offerMove = path !== data.settings.downloadPath && torrents.length > 0;
  const checking = torrents.find(
    (torrent) => torrent.status === "checking" || torrent.status === "moving"
  );
  const dirty =
    path !== data.settings.downloadPath ||
    theme !== data.settings.theme ||
    runInBackground !== data.settings.runInBackground ||
    down !==
      (data.settings.downloadLimit === -1 ? "" : String(data.settings.downloadLimit / 1024)) ||
    up !== (data.settings.uploadLimit === -1 ? "" : String(data.settings.uploadLimit / 1024));
  const action = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update settings");
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void action(async () => {
      const settings = await request<Settings>("/settings", "PUT", {
        downloadLimit: down === "" ? -1 : Math.round(Number(down) * 1024),
        downloadPath: path,
        moveFiles: offerMove && moveFiles,
        runInBackground,
        theme,
        uploadLimit: up === "" ? -1 : Math.round(Number(up) * 1024),
      });
      applyTheme(settings.theme);
      setPath(settings.downloadPath);
      setMoveFiles(false);
      await refresh();
      setSaved(true);
    });
  };
  const back = () => {
    if (settingsBackPath.startsWith("/library/destinations/")) {
      void router.navigate({
        params: { id: decodeURIComponent(settingsBackPath.slice("/library/destinations/".length)) },
        resetScroll: false,
        to: "/library/destinations/:id",
      });
    } else {
      void router.navigate({
        resetScroll: false,
        to: settingsBackPath === "/anilist" ? "/anilist" : "/library/all",
      });
    }
  };
  return (
    <div className="settings-page">
      <aside className="settings-navigation">
        <div className="settings-brand">
          <Logo />
          <strong>Tofu</strong>
        </div>
        <nav aria-label="Settings sections">
          {sections.map(({ id, label, icon: Icon }) => (
            <Button
              aria-current={section === id ? "page" : undefined}
              className="settings-nav-item"
              key={id}
              onClick={() => setSection(id)}
              variant={section === id ? "secondary" : "ghost"}
            >
              <Icon data-icon="inline-start" />
              {label}
            </Button>
          ))}
        </nav>
        <div className="settings-footer">
          <Button className="settings-back" disabled={busy} onClick={back} variant="ghost">
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
          <SidebarUpdateAction />
        </div>
      </aside>
      <main className="settings-main">
        <header className="settings-topbar">
          <h1>
            <span>Settings</span>
            <span aria-hidden="true">/</span>
            {sections.find((item) => item.id === section)?.label}
          </h1>
          {(section !== "updates" || dirty) && (
            <Button disabled={busy || !dirty} form="settings-form" type="submit" variant="outline">
              {busy === true && (
                <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
              )}
              {busy ? "Saving…" : "Save"}
            </Button>
          )}
        </header>
        <form
          className="settings-content"
          id="settings-form"
          onChange={() => setSaved(false)}
          onInvalidCapture={() => setSection("downloads")}
          onSubmit={save}
        >
          {section !== "updates" && (
            <p className="settings-intro">
              Preferences for this device. Changes apply when you save.
            </p>
          )}
          <div hidden={section !== "general"}>
            <FieldSet>
              <FieldLegend>Behavior</FieldLegend>
              <FieldGroup className="settings-group">
                {data.session.mode === "desktop" ? (
                  <Field className="settings-row" orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="run-in-background">Run in background</FieldLabel>
                      <FieldDescription>
                        Keep transfers and automations running when you close the window. Use the
                        menu bar icon to reopen Tofu. Quit Tofu stops the server.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={runInBackground}
                      disabled={busy}
                      id="run-in-background"
                      onCheckedChange={(value) => {
                        setRunInBackground(value === true);
                        setSaved(false);
                      }}
                    />
                  </Field>
                ) : (
                  <Field className="settings-row">
                    <FieldContent>
                      <FieldLabel>Web workspace</FieldLabel>
                      <FieldDescription>
                        Transfers continue on the server when you close this browser tab.
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                )}
                {data.session.mode === "desktop" && data.settings.runInBackground && (
                  <Field className="settings-row" orientation="horizontal">
                    <FieldContent>
                      <FieldLabel>Background mode</FieldLabel>
                      <FieldDescription>
                        Hide the window and keep Tofu running in the menu bar.
                      </FieldDescription>
                    </FieldContent>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await request("/desktop/background", "POST", {});
                        })
                      }
                      variant="outline"
                    >
                      Switch to background mode now
                    </Button>
                  </Field>
                )}
              </FieldGroup>
            </FieldSet>
            <p className="settings-note">
              Your transfers and preferences are stored on this machine.
            </p>
          </div>
          <div hidden={section !== "appearance"}>
            <FieldSet>
              <FieldLegend>Interface</FieldLegend>
              <FieldGroup className="settings-group">
                <Field className="settings-row" orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="appearance-theme">Appearance</FieldLabel>
                    <FieldDescription id="appearance-description">
                      Choose a theme. System follows your device’s appearance automatically.
                    </FieldDescription>
                  </FieldContent>
                  <OptionSelect
                    ariaDescribedBy="appearance-description"
                    className="settings-select"
                    disabled={busy}
                    id="appearance-theme"
                    onValueChange={(value) => {
                      setTheme(value);
                      setSaved(false);
                    }}
                    options={themeOptions}
                    value={theme}
                  />
                </Field>
              </FieldGroup>
            </FieldSet>
          </div>
          <div hidden={section !== "downloads"}>
            <FieldSet>
              <FieldLegend>Storage</FieldLegend>
              <FieldGroup className="settings-group">
                <Field className="settings-row settings-folder">
                  <FieldContent>
                    <FieldLabel htmlFor="destination-path">Download folder</FieldLabel>
                    <FieldDescription id="download-folder-description">
                      The default folder for future additions. Existing files stay in their current
                      location unless you choose to move them.
                    </FieldDescription>
                  </FieldContent>
                  <InputGroup>
                    <InputGroupInput
                      aria-describedby="download-folder-description"
                      disabled={busy}
                      id="destination-path"
                      onChange={(event) => setPath(event.target.value)}
                      required
                      value={path}
                    />
                    {data.session.mode === "desktop" && (
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              const result = await request<{ path: string | null }>(
                                "/directory",
                                "POST",
                                undefined
                              );
                              if (result.path) {
                                setPath(result.path);
                              }
                            })
                          }
                          type="button"
                        >
                          <FolderIcon />
                          Browse
                        </InputGroupButton>
                      </InputGroupAddon>
                    )}
                  </InputGroup>
                </Field>
                {offerMove === true && (
                  <Field className="settings-row" orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="move-files">Move downloaded files</FieldLabel>
                      <FieldDescription>
                        {torrents.length} torrent{torrents.length === 1 ? "" : "s"} in Downloads.
                        Transfers stop during the move, then resume. Paused torrents remain paused.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      checked={moveFiles}
                      disabled={busy}
                      id="move-files"
                      onCheckedChange={(value) => {
                        setMoveFiles(value === true);
                        setSaved(false);
                      }}
                    />
                  </Field>
                )}
              </FieldGroup>
            </FieldSet>
            {offerMove === true && moveFiles === true && checking !== undefined && (
              <Alert variant="destructive">
                <AlertDescription>
                  {checking.name} is undergoing{" "}
                  {checking.status === "checking" ? "verification" : "move"}. Wait for completion
                  before moving its files.
                </AlertDescription>
              </Alert>
            )}
            <FieldSet>
              <FieldLegend>Bandwidth</FieldLegend>
              <FieldGroup className="settings-group">
                <Field className="settings-row" orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="limit-download">Download limit</FieldLabel>
                    <FieldDescription id="download-limit-description">
                      KiB/s · Empty means unlimited. 0 pauses download traffic.
                    </FieldDescription>
                  </FieldContent>
                  <Input
                    aria-describedby="download-limit-description"
                    disabled={busy}
                    id="limit-download"
                    min="0"
                    onChange={(event) => setDown(event.target.value)}
                    placeholder="Unlimited"
                    step="1"
                    type="number"
                    value={down}
                  />
                </Field>
                <Field className="settings-row" orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="limit-upload">Upload limit</FieldLabel>
                    <FieldDescription id="upload-limit-description">
                      KiB/s · Empty means unlimited. 0 pauses upload traffic.
                    </FieldDescription>
                  </FieldContent>
                  <Input
                    aria-describedby="upload-limit-description"
                    disabled={busy}
                    id="limit-upload"
                    min="0"
                    onChange={(event) => setUp(event.target.value)}
                    placeholder="Unlimited"
                    step="1"
                    type="number"
                    value={up}
                  />
                </Field>
              </FieldGroup>
            </FieldSet>
          </div>
          <div className="settings-updates" hidden={section !== "updates"}>
            <UpdatesPanel disabled={busy} />
          </div>
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <p aria-live="polite" className="settings-feedback" id="settings-feedback" role="status">
            {busy && offerMove && moveFiles
              ? "Moving files. This may take some time depending on their size."
              : dirty
                ? "You have unsaved changes."
                : saved
                  ? "Settings saved."
                  : ""}
          </p>
        </form>
      </main>
    </div>
  );
}
