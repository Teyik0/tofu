import { cn } from "cn";
import { ActionTooltip } from "./action-tooltip";
import { SidebarTrigger, useSidebar } from "./ui/sidebar";

export function SidebarToggle({ className }: { className?: string }) {
  const { isMobile, open, openMobile } = useSidebar();
  return (
    <ActionTooltip>
      <SidebarTrigger
        aria-expanded={isMobile ? openMobile : open}
        aria-label="Toggle sidebar"
        className={cn("sidebar-toggle", className)}
      />
    </ActionTooltip>
  );
}
