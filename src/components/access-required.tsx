import { LockIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Skeleton } from "./ui/skeleton";

/** Shown instead of host controls the current device is not allowed to use. */
export function AccessRequired({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="access-required">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Reserved space while permissions or host data load; never flashes privileged controls. */
export function SettingsSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="settings-skeleton" role="status">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
