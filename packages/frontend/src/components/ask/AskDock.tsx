import { usePendingAsks } from "../../store/ask";
import { AskFormCard } from "./AskFormCard";

/** composer 正上方的提问停靠区。pending 提问纵向堆叠；回答后自动消失（pendingAsks 移除）。
 *  宽度与下方 composer 输入框对齐（max-w-[860px] 居中）。 */
export function AskDock({ sessionId }: { sessionId: string }) {
  const asks = usePendingAsks(sessionId);
  if (asks.length === 0) return null;
  return (
    <div className="px-6 pt-3" data-testid={`ask-dock-${sessionId}`}>
      <div className="w-full max-w-[860px] mx-auto space-y-3">
        {asks.map(a => <AskFormCard key={a.toolCallId} sessionId={sessionId} toolCallId={a.toolCallId} params={a.params} agentName={a.agentName} />)}
      </div>
    </div>
  );
}
