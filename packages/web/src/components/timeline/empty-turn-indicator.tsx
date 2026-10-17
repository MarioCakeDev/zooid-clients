import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const EMPTY_TURN_TOOLTIP =
  "No content was produced. This may be deliberate, or may indicate an error swallowed upstream — by the ACP adapter, the harness, or the model provider.";

/**
 * Neutral marker for a turn that ended having sent nothing ([[ZOD076]]). It
 * states the fact and nothing more: the daemon can't tell a deliberate silence
 * from a swallowed provider error, so neither does the styling.
 */
export function EmptyTurnIndicator({
  agentName,
  stopReason,
}: {
  agentName: string;
  stopReason?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="cursor-default rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
            {agentName} ended its turn without output
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <div className="flex flex-col gap-1">
            <span>{EMPTY_TURN_TOOLTIP}</span>
            {stopReason ? <span>Stop reason: {stopReason}</span> : null}
          </div>
        </TooltipContent>
      </Tooltip>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
