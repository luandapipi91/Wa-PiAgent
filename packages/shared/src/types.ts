// ===== Agent 配置（对应 ~/.pi/agent/agents/<name>.md frontmatter，spec 5.1）=====
export interface AgentConfig {
  name: string;
  displayName: string;
  avatar: string;            // emoji，如 "⚙️"
  description: string;
  model: string;             // "deepseek/deepseek-v4-flash"
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools: string[];           // 工具 allowlist
  skills: string[];
  partners: { askTo: string[]; askFrom: string[] };
  systemPrompt?: string;     // frontmatter 之后的 markdown body
}

// ===== Pi RPC 事件（pi --mode rpc stdout 每行一个，已验证）=====
export type RPCEvent =
  | { type: "response"; id: string; command: string; success: boolean; data?: unknown }
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: RPCMessage }
  | { type: "message_update"; assistantMessageEvent: { type: string; partial?: { content: Array<{ type: string; text?: string }> } } }
  | { type: "message_end"; message: RPCMessage }
  | { type: "turn_end"; message: RPCMessage; toolResults: unknown[] }
  | { type: "agent_end"; messages: RPCMessage[] }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: { content: Array<{ type: string; text?: string }> }; isError: boolean };

export interface RPCMessage {
  role: "user" | "assistant" | "tool";
  content: Array<{ type: string; text?: string }>;
}

// ===== 前端 ↔ 内核 WebSocket 事件 =====
export type WSEvent =
  | { type: "agents:list"; agents: AgentConfig[] }
  | { type: "agent:state"; agentName: string; state: AgentState }
  | { type: "agent:message"; agentName: string; message: ChatMessage }
  | { type: "agent:tool"; agentName: string; toolName: string; toolCallId: string; phase: "start" | "end"; result?: string }
  | { type: "intercom:ask"; from: string; to: string; messageId: string; text: string; startedAt: number }
  | { type: "intercom:reply"; toAskMessageId: string; text: string }
  | { type: "intercom:queue"; agentName: string; queue: Array<{ from: string; text: string; startedAt: number }> };

export interface AgentState {
  status: "idle" | "thinking" | "blocked" | "error";
  model?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}
