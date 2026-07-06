import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SESSIONS_DIR } from "@hiagent/shared";
import type { ChatMessage, AskItem } from "@hiagent/shared";

interface SessionFile {
  messages: ChatMessage[];
  intercomEvents: AskItem[];
}

// 注意：不能用模块级 const EMPTY + { ...EMPTY }，浅拷贝会使 messages/intercomEvents
// 数组跨实例共享，appendMessage 的 push 会污染后续调用（Task 6 ProjectStore 已踩此坑）
function emptySession(): SessionFile {
  return { messages: [], intercomEvents: [] };
}

export class SessionStore {
  constructor(private dir: string = SESSIONS_DIR) {}

  private path(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  private async read(sessionId: string): Promise<SessionFile> {
    try {
      const raw = await readFile(this.path(sessionId), "utf8");
      const data = JSON.parse(raw) as Partial<SessionFile>;
      return {
        messages: data.messages ?? [],
        intercomEvents: data.intercomEvents ?? [],
      };
    } catch {
      return emptySession();
    }
  }

  private async write(sessionId: string, data: SessionFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(sessionId), JSON.stringify(data, null, 2), "utf8");
  }

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    return (await this.read(sessionId)).messages;
  }

  async appendMessage(sessionId: string, msg: ChatMessage): Promise<void> {
    const data = await this.read(sessionId);
    data.messages.push(msg);
    await this.write(sessionId, data);
  }

  async loadAsks(sessionId: string): Promise<AskItem[]> {
    return (await this.read(sessionId)).intercomEvents;
  }

  async appendAsk(sessionId: string, ask: AskItem): Promise<void> {
    const data = await this.read(sessionId);
    data.intercomEvents.push(ask);
    await this.write(sessionId, data);
  }

  async resolveAsk(sessionId: string, askMessageId: string): Promise<void> {
    const data = await this.read(sessionId);
    const ask = data.intercomEvents.find(a => a.messageId === askMessageId);
    if (ask) {
      ask.resolved = true;
      ask.resolvedAt = Date.now();
      await this.write(sessionId, data);
    }
  }
}
