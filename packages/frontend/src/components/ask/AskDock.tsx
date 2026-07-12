import { usePendingAsks } from "../../store/ask";
import { AskFormCard } from "./AskFormCard";

/** composer 正上方的提问停靠区。pending 提问纵向堆叠；回答后自动消失（pendingAsks 移除）。 */
export function AskDock({ sessionId }: { sessionId: string }) {
  const asks = usePendingAsks(sessionId);
  if (asks.length === 0) return null;
  return (
    <div className="px-6 pt-3 space-y-3" data-testid={`ask-dock-${sessionId}`}>
      {asks.map(a => <AskFormCard key={a.toolCallId} sessionId={sessionId} toolCallId={a.toolCallId} params={a.params} />)}
    </div>
  );
}
