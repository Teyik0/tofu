import { useQuery } from "@teyik0/furin/client";
import { AniListIcon } from "@tofu/anilist/components/icon";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import { Badge } from "@tofu/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@tofu/ui/dialog";
import { Skeleton } from "@tofu/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@tofu/ui/tabs";
import {
  HistoryIcon,
  InboxIcon,
  ListChecksIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";
import { api } from "../lib/client";
import type { AutomationSection, DashboardState } from "../types";
import { AutomationDiscovery } from "./automation-discovery";
import { isPending } from "./automation-inbox";
import { AutomationRules } from "./automation-rules";
import {
  AutomationAniListSection,
  AutomationHistorySection,
  AutomationInboxSection,
  AutomationPreferencesSection,
} from "./automation-sections";

export type { AutomationSection } from "../types";

export function AutomationCenter({
  dashboard,
  destinationId,
  section,
  close,
}: {
  dashboard: DashboardState;
  destinationId: string;
  section: AutomationSection;
  close: () => void;
}) {
  const { data: live, error: loadingError } = useQuery(api.automation.get);
  const state = live && "plugins" in live ? live : null;
  const [tab, setTab] = useState<AutomationSection>(() => section);
  const [target, setTarget] = useState(() => destinationId);
  const pending = state?.decisions.filter(isPending) ?? [];
  const panel = state ? { dashboard, onTarget: setTarget, setTab, state, target } : null;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
    >
      <DialogContent className="automation-dialog">
        <Tabs
          className="automation-layout"
          onValueChange={(value) => setTab(value as AutomationSection)}
          orientation="vertical"
          value={tab}
        >
          <aside className="automation-nav">
            <DialogHeader className="automation-brand">
              <DialogTitle>
                <ZapIcon aria-hidden="true" />
                Automations
              </DialogTitle>
              <DialogDescription>
                Tofu watches your sources and downloads new releases into your threads.
              </DialogDescription>
            </DialogHeader>
            <TabsList aria-label="Automation sections" variant="line">
              <TabsTrigger value="inbox">
                <InboxIcon />
                Inbox
                {pending.length ? <Badge>{pending.length}</Badge> : null}
              </TabsTrigger>
              <TabsTrigger value="rules">
                <ListChecksIcon />
                Rules
              </TabsTrigger>
              <TabsTrigger value="anilist">
                <AniListIcon />
                AniList tracking
              </TabsTrigger>
              <TabsTrigger value="discover">
                <SearchIcon />
                Discover
              </TabsTrigger>
              <TabsTrigger value="history">
                <HistoryIcon />
                History
              </TabsTrigger>
              <TabsTrigger value="preferences">
                <SlidersHorizontalIcon />
                Preferences
              </TabsTrigger>
            </TabsList>
          </aside>

          <div className="automation-main">
            {loadingError ? (
              <Alert variant="destructive">
                <AlertDescription>Unable to load automations</AlertDescription>
              </Alert>
            ) : null}
            {panel ? (
              <>
                <AutomationInboxSection {...panel} />
                <AutomationRules key={target} {...panel} />
                <AutomationAniListSection {...panel} />
                <AutomationDiscovery {...panel} />
                <AutomationHistorySection {...panel} />
                <AutomationPreferencesSection {...panel} />
              </>
            ) : (
              <Skeleton className="h-40" />
            )}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
