import { useField, useForm } from "@formisch/react";
import { BookOpenIcon, ListChecksIcon, ZapIcon } from "lucide-react";
import { object, string } from "valibot";
import type { AniListEntry, AniListMedia } from "../../api/modules/anilist/types";
import type { AutomationState } from "../../api/modules/automation/model";
import type { LiveState } from "../../api/modules/dashboard/projection";
import type { EpisodeSource } from "../../api/modules/library-links/availability";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { EpisodeHeader } from "./_episode-header";
import { EpisodeAutomationPanel, EpisodeDownloadsPanel, EpisodeListPanel } from "./_episode-panels";
import { useAniListEditor } from "./hooks/_use-anilist-editor";
import { useAniListReleases } from "./hooks/_use-anilist-releases";

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
