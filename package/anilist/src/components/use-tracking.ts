import { getDeepError, useField, useForm } from "@formisch/react";
import { useMutation } from "@teyik0/furin/client";
import type {
  AniListStatus,
  AniListThreadProposal,
  AutomationDraft,
  AutomationPreferences,
} from "@tofu/plugins/domain";
import { useNow } from "@tofu/ui/use-now";
import { useState } from "react";
import { api } from "../client-api";
import { trackingFormSchema } from "../server/model";
import type { AniListPanelProps } from "./panel";
import { aniListStatusLabel } from "./status";

export type AniListTrackingProps = AniListPanelProps;

export function useAniListTracking({
  target,
  preferences,
  plugin,
  destinations,
  state,
}: Pick<AniListTrackingProps, "target" | "preferences" | "plugin" | "destinations" | "state">) {
  const selectEntry = useMutation((mediaId: number, enabled: boolean) =>
    api.anilist.entries({ mediaId }).put({ enabled })
  );
  const createSubscription = useMutation(api.anilist.subscriptions.post);
  const loadList = useMutation(api.anilist.list.post);
  const syncSubscription = useMutation((id: string) =>
    api.anilist.subscriptions({ id }).sync.post()
  );
  const toggleSubscription = useMutation((id: string, enabled: boolean) =>
    api.anilist.subscriptions({ id }).put({ enabled })
  );
  const removeSubscription = useMutation((id: string) =>
    api.anilist.subscriptions({ id }).delete()
  );
  const trackingForm = useForm({
    initialInput: {
      basePath: destinations.find((destination) => destination.id === target)?.downloadPath ?? "",
      custom: null,
      mode: "per-anime",
      proposals: null,
      statuses: ["CURRENT", "PLANNING"],
    },
    schema: trackingFormSchema,
  });
  const statusesField = useField(trackingForm, { path: ["statuses"] });
  const modeField = useField(trackingForm, { path: ["mode"] });
  const basePathField = useField(trackingForm, { path: ["basePath"] });
  const customField = useField(trackingForm, { path: ["custom"] });
  const proposalsField = useField(trackingForm, { path: ["proposals"] });
  const statuses = (statusesField.input ?? []).filter(
    (status): status is AniListStatus => status !== undefined
  );
  const setStatuses = statusesField.onChange;
  const mode = modeField.input ?? "per-anime";
  const setMode = modeField.onChange;
  const basePath = basePathField.input ?? "";
  const setBasePath = basePathField.onChange;
  // Both editors always write complete API-shaped values into these fields.
  const custom = customField.input as AutomationPreferences | null;
  const setCustom = customField.onChange;
  const proposals = proposalsField.input as AniListThreadProposal[] | null;
  const setProposals = proposalsField.onChange;
  const [prepared, setPrepared] = useState(false);
  const trackingError = getDeepError(trackingForm);
  const now = useNow(60_000);
  const pluginEnabled = plugin?.enabled === true;
  const unprepare = () => {
    setPrepared(false);
    setProposals(null);
  };
  const trackedStatuses = new Set(statuses);
  const visible = state.entries.filter((entry) => trackedStatuses.has(entry.status));
  const approved = (mediaId: number) =>
    state.selections.some((selection) => selection.mediaId === mediaId && selection.enabled);
  const selectedCount = visible.filter((entry) => approved(entry.mediaId)).length;
  const formats = custom ?? preferences;
  const template: AutomationDraft = {
    ...formats,
    destinationId: target,
    enabled: true,
    includeExisting: true,
    matchMode: "exact",
    query: `AniList: ${statuses.map(aniListStatusLabel).join(" + ") || "lists"}`,
    season: null,
    title: "Titles from my AniList lists",
  };
  const subscriptions = state.subscriptions.filter(
    (subscription) => subscription.template.destinationId === target
  );

  return {
    approved,
    basePath,
    basePathField,
    createSubscription,
    custom,
    formats,
    loadList,
    mode,
    now,
    pluginEnabled,
    prepared,
    proposals,
    removeSubscription,
    selectEntry,
    selectedCount,
    setBasePath,
    setCustom,
    setMode,
    setPrepared,
    setProposals,
    setStatuses,
    statuses,
    subscriptions,
    syncSubscription,
    template,
    toggleSubscription,
    trackingError,
    trackingForm,
    unprepare,
    visible,
  };
}
