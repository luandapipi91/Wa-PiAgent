import { useEffect, useRef } from "react";
import { useSession } from "../store/session";
import { useAgents } from "../store/agents";
import { useIntercom } from "../store/intercom";
import { MessageItem } from "./MessageItem";
import { AskCard } from "./AskCard";

export function MessageList({ agentName }: { agentName: string }) {
  const messages = useSession(s => s.messages[agentName] ?? []);
  const agent = useAgents(s => s.list.find(a => a.name === agentName));
  const asks = useIntercom(s => s.asks.filter(a => a.from === agentName || a.to === agentName));
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, asks]);
  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3.5">
      {messages.map(m => <MessageItem key={m.id} msg={m} agentAvatar={agent?.avatar ?? "🤖"} agentName={agent?.displayName ?? agentName} agentKey={agentName} />)}
      {asks.map(a => <AskCard key={a.messageId} ask={a} />)}
      <div ref={endRef} />
    </div>
  );
}
