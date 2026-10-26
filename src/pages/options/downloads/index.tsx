import { useField, useForm } from "@formisch/react";
import { defineRoute } from "@teyik0/furin";
import { useAtomValue } from "jotai";
import { FolderIcon } from "lucide-react";
import { startTransition } from "react";
import { pick } from "valibot";
import type { HostState, LibraryTorrent } from "../../../api/modules/dashboard/projection";
import { bandwidthInputSchema, settingsSchema } from "../../../api/modules/settings/model";
import { AccessRequired, SettingsSkeleton } from "../../../components/access-required";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "../../../components/ui/field";
import { Input } from "../../../components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../../../components/ui/input-group";
import { Switch } from "../../../components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { useAutosaveField } from "../../../hooks/use-autosave-field";
import { useSettingsAction } from "../../../hooks/use-settings-action";
import { dashboardAtom, sessionAtom } from "../../../state/workspace";

export const route = defineRoute("/options/downloads")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "Download settings — Tofu" }] }))
  .page(() => {
    const live = useAtomValue(dashboardAtom);
    const session = useAtomValue(sessionAtom);
    if (session && !session.capabilities.administer) {
      return (
        <AccessRequired
          description={`Downloads and bandwidth are managed by ${session.server.name}'s administrators.`}
          title="Administration access required"
        />
      );
    }
    if (!(session && live?.host)) {
      return <SettingsSkeleton label="Loading download settings" />;
    }
    return (
      <DownloadSettings
        host={live.host}
        hostNative={session.capabilities.hostNative}
        owner={session.capabilities.owner}
        serverName={session.server.name}
        torrents={live.torrents}
      />
    );
  });

/** Applies to the server; the folder itself is chosen on the server computer. */
function DownloadSettings({
  host,
  owner,
  hostNative,
  serverName,
  torrents: library,
}: {
  host: HostState;
  owner: boolean;
  hostNative: boolean;
  serverName: string;
  torrents: LibraryTorrent[];
}) {
  const data = { settings: host.settings, torrents: library };
  const { busy, dispatchAction, error: serverError, saveSettings } = useSettingsAction();
  const optionsForm = useForm({
    initialInput: { moveFiles: false },
    schema: pick(settingsSchema, ["moveFiles"]),
  });
  const moveFilesField = useField(optionsForm, { path: ["moveFiles"] });
  const moveFiles = moveFilesField.input === true;
  const folder = useAutosaveField(
    settingsSchema.entries.downloadPath,
    data.settings.downloadPath,
    async (downloadPath) => {
      const settings = await saveSettings({ downloadPath, moveFiles });
      return settings.downloadPath;
    }
  );
  const download = useAutosaveField(
    bandwidthInputSchema,
    data.settings.downloadLimit === -1 ? "" : String(data.settings.downloadLimit / 1024),
    async (downloadLimit) => {
      const settings = await saveSettings({ downloadLimit });
      return settings.downloadLimit === -1 ? "" : String(settings.downloadLimit / 1024);
    }
  );
  const upload = useAutosaveField(
    bandwidthInputSchema,
    data.settings.uploadLimit === -1 ? "" : String(data.settings.uploadLimit / 1024),
    async (uploadLimit) => {
      const settings = await saveSettings({ uploadLimit });
      return settings.uploadLimit === -1 ? "" : String(settings.uploadLimit / 1024);
    }
  );
  const error = folder.error ?? download.error ?? upload.error ?? serverError;
  const torrents = data.torrents.filter((torrent) => torrent.destinationId === "default");
  const checking = torrents.find(
    (torrent) => torrent.status === "checking" || torrent.status === "moving"
  );
  return (
    <div aria-busy={busy}>
      <FieldSet>
        <FieldLegend>Storage</FieldLegend>
        <FieldGroup className="settings-group">
          <Field className="settings-row settings-folder">
            <FieldContent>
              <FieldLabel htmlFor="destination-path">Download folder</FieldLabel>
              <FieldDescription id="download-folder-description">
                {owner
                  ? "The default folder for future additions. Existing files stay in their current location unless you choose to move them. Folder and bandwidth changes apply when you leave the field or press Enter."
                  : `Folders on ${serverName} are changed on ${serverName} itself.`}
              </FieldDescription>
            </FieldContent>
            <InputGroup>
              <InputGroupInput
                aria-describedby="download-folder-description"
                disabled={busy || !owner || (moveFiles && checking !== undefined)}
                readOnly={!owner}
                {...folder.field.props}
                aria-invalid={Boolean(folder.field.errors)}
                id="destination-path"
                onBlur={folder.onBlur}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                required
                value={folder.field.input ?? ""}
              />
              {Boolean(hostNative) && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    disabled={busy || (moveFiles && checking !== undefined)}
                    onClick={() =>
                      startTransition(() => dispatchAction({ moveFiles, type: "browse" }))
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
          {owner && torrents.length > 0 && (
            <Field className="settings-row" orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="move-files">Move files when changing folders</FieldLabel>
                <FieldDescription>
                  {torrents.length} torrent{torrents.length === 1 ? "" : "s"} in Downloads. Enable
                  this before choosing a new folder. Transfers stop during the move, then resume.
                  Paused torrents remain paused.
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={moveFiles}
                disabled={busy || checking !== undefined}
                id="move-files"
                onCheckedChange={moveFilesField.onChange}
              />
            </Field>
          )}
        </FieldGroup>
      </FieldSet>
      {checking !== undefined && (
        <Alert variant="destructive">
          <AlertDescription>
            {checking.name} is undergoing {checking.status === "checking" ? "verification" : "move"}
            . Wait for completion before moving its files.
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
              {...download.field.props}
              aria-invalid={Boolean(download.field.errors)}
              id="limit-download"
              min="0"
              onBlur={download.onBlur}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              placeholder="Unlimited"
              step="1"
              type="number"
              value={download.field.input ?? ""}
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
              {...upload.field.props}
              aria-invalid={Boolean(upload.field.errors)}
              id="limit-upload"
              min="0"
              onBlur={upload.onBlur}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              placeholder="Unlimited"
              step="1"
              type="number"
              value={upload.field.input ?? ""}
            />
          </Field>
        </FieldGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend>Seeding</FieldLegend>
        <FieldGroup className="settings-group">
          <Field className="settings-row" data-disabled={busy} orientation="horizontal">
            <FieldContent>
              <FieldTitle id="seeding-connections-label">Seeding connections</FieldTitle>
              <FieldDescription id="seeding-connections-description">
                Balanced connects to new peers at a reduced rate once a torrent is complete.
                Incoming only waits for peers to connect and may reduce sharing if your port is
                unreachable. Existing connections stay open. Downloads are unaffected.
              </FieldDescription>
            </FieldContent>
            <ToggleGroup
              aria-describedby="seeding-connections-description"
              aria-labelledby="seeding-connections-label"
              disabled={busy}
              id="seeding-connections"
              onValueChange={([seedingConnectionMode]) => {
                if (
                  seedingConnectionMode === "balanced" ||
                  seedingConnectionMode === "incoming-only"
                ) {
                  startTransition(() =>
                    dispatchAction({ settings: { seedingConnectionMode }, type: "update" })
                  );
                }
              }}
              value={[data.settings.seedingConnectionMode]}
              variant="outline"
            >
              <ToggleGroupItem value="balanced">Balanced</ToggleGroupItem>
              <ToggleGroupItem value="incoming-only">Incoming only</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </FieldGroup>
      </FieldSet>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
