import { ActionTooltip } from "@tofu/ui/action-tooltip";
import { SidebarTrigger, useSidebar } from "@tofu/ui/sidebar";
import { cn } from "cn";

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
