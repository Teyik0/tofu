import { useField, useForm } from "@formisch/react";
import type { LiveState } from "@tofu/plugins/library-state";
import { BookOpenIcon, ListChecksIcon, ZapIcon } from "lucide-react";
import { object, string } from "valibot";
import type { AutomationState } from "../../../plugins/src/automation-model";
import type { EpisodeSource } from "../../../plugins/src/availability";
import { Dialog, DialogContent } from "../../../ui/src/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "../../../ui/src/ui/tabs";
import { useAniListEditor } from "../hooks/use-anilist-editor";
import { useAniListReleases } from "../hooks/use-anilist-releases";
import type { AniListEntry, AniListMedia } from "../server/types";
import { EpisodeHeader } from "./episode-header";
import { EpisodeAutomationPanel, EpisodeDownloadsPanel, EpisodeListPanel } from "./episode-panels";

export function AniListEpisodeModal({
  authenticated,
  dashboard,
  entry,
  automation,
  close,
  episode,
  localSources,
}: {
  authenticated: boolean;
  dashboard: LiveState;
  entry: AniListMedia | AniListEntry;
  automation: AutomationState;
  close: () => void;
  episode?: number;
  localSources?: EpisodeSource[];
}) {
  const listed = "progress" in entry;
  const rule = listed
    ? automation.automations.find((item) => item.id === entry.automationId)
    : undefined;
  const destinationForm = useForm({
    initialInput: { destinationId: rule?.destinationId ?? "default" },
    schema: object({ destinationId: string() }),
  });
  const destination = useField(destinationForm, { path: ["destinationId"] });
  const editor = useAniListEditor(authenticated, entry.mediaId);
  const releases = useAniListReleases(entry);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
    >
      <DialogContent className="anime-modal">
        <EpisodeHeader
          authenticated={authenticated}
          available={releases.result || releases.available ? releases.available : null}
          entry={entry}
          model={editor}
        />
        <div className="anime-modal-body">
          <Tabs defaultValue={episode === undefined ? "list" : "episodes"}>
            <TabsList variant="line">
              <TabsTrigger value="list">
                <ListChecksIcon />
                My list
              </TabsTrigger>
              <TabsTrigger value="episodes">
                <BookOpenIcon />
                Episodes
              </TabsTrigger>
              <TabsTrigger disabled={!listed} value="automation">
                <ZapIcon />
                Automation
              </TabsTrigger>
            </TabsList>
            <EpisodeListPanel
              authenticated={authenticated}
              close={close}
              entry={entry}
              model={editor}
            />
            <EpisodeDownloadsPanel
              automation={automation}
              dashboard={dashboard}
              destinationId={destination.input ?? "default"}
              entry={entry}
              episode={episode}
              localSources={localSources}
              model={releases}
              setDestinationId={destination.onChange}
            />
            <EpisodeAutomationPanel
              dashboard={dashboard}
              destinationId={destination.input ?? "default"}
              entry={entry}
              reload={releases.reload}
              rule={rule}
              setDestinationId={destination.onChange}
            />
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
