import { useField, useForm } from "@formisch/react";
import { defineRoute } from "@teyik0/furin";
import { getRouteApi } from "@teyik0/furin/client";
import { FolderIcon } from "lucide-react";
import { startTransition } from "react";
import { pick } from "valibot";
import { bandwidthInputSchema, settingsSchema } from "../../api/modules/settings/model";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../../components/ui/input-group";
import { Switch } from "../../components/ui/switch";
import { useAutosaveField } from "../../hooks/use-autosave-field";
import { useSettingsAction } from "../../hooks/use-settings-action";
import { route as options } from "./_route";

export const route = defineRoute()
  .config({ layout: options, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Download settings — Tofu" }] }))
  .page(() => {
    const { dashboard: data } = getRouteApi("/options/downloads").useLoaderData();
    const { busy, dispatchAction, error: serverError } = useSettingsAction();
    const optionsForm = useForm({
      initialInput: { moveFiles: false },
      schema: pick(settingsSchema, ["moveFiles"]),
    });
    const moveFilesField = useField(optionsForm, { path: ["moveFiles"] });
    const moveFiles = moveFilesField.input === true;
    const folder = useAutosaveField(
      settingsSchema.entries.downloadPath,
      data.settings.downloadPath,
      (downloadPath) => {
        startTransition(() =>
          dispatchAction({ settings: { downloadPath, moveFiles }, type: "update" })
        );
      }
    );
    const download = useAutosaveField(
      bandwidthInputSchema,
      data.settings.downloadLimit === -1 ? "" : String(data.settings.downloadLimit / 1024),
      (downloadLimit) => {
        startTransition(() => dispatchAction({ settings: { downloadLimit }, type: "update" }));
      }
    );
    const upload = useAutosaveField(
      bandwidthInputSchema,
      data.settings.uploadLimit === -1 ? "" : String(data.settings.uploadLimit / 1024),
      (uploadLimit) => {
        startTransition(() => dispatchAction({ settings: { uploadLimit }, type: "update" }));
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
                  The default folder for future additions. Existing files stay in their current
                  location unless you choose to move them. Folder and bandwidth changes apply when
                  you leave the field or press Enter.
                </FieldDescription>
              </FieldContent>
              <InputGroup>
                <InputGroupInput
                  aria-describedby="download-folder-description"
                  disabled={busy || (moveFiles && checking !== undefined)}
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
                {data.session.mode === "desktop" && (
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
            {torrents.length > 0 && (
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
              {checking.name} is undergoing{" "}
              {checking.status === "checking" ? "verification" : "move"}. Wait for completion before
              moving its files.
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
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  });
