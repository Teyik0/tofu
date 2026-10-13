import { Tooltip, TooltipContent, TooltipTrigger } from "@tofu/ui/tooltip";
import type { ReactElement } from "react";

export function ActionTooltip({ children }: { children: ReactElement<{ "aria-label": string }> }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent sideOffset={6}>{children.props["aria-label"]}</TooltipContent>
    </Tooltip>
  );
}
