import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function ActionTooltip({ children }: { children: ReactElement<{ "aria-label": string }> }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent sideOffset={6}>{children.props["aria-label"]}</TooltipContent>
    </Tooltip>
  );
}
