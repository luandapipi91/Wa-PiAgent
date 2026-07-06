### Task 7: SessionStore（读写 sessions/<id>.json + 迁移）

**Files:**
- Create: `packages/kernel/src/session-store.ts`
- Test: `packages/kernel/tests/session-store.test.ts`

**Interfaces:**
- Consumes: `SESSIONS_DIR`, `ChatMessage`, `AskItem`, `SessionEntity` from `@hiagent/shared`
- Produces:
  - `class SessionStore { constructor(dir?: string); loadMessages(sessionId): Promise<ChatMessage[]>; appendMessage(sessionId, msg): Promise<void>; loadAsks(sessionId): Promise<AskItem[]>; appendAsk(sessionId, ask): Promise<void>; resolveAsk(sessionId, askMessageId): Promise<void>; }`
  - 迁移函数 `migrateLegacySessions(projectStore, sessionStore, legacyAgentMessages): Promise<void>`（老用户首次启动，Task 33 用）

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/session-store.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/session-store";
import type { ChatMessage, AskItem } from "@hiagent/shared";

function tempDir() {
  return join(import.meta.dir, ".tmp-sessions-" + Math.random().toString(36).slice(2));
}

const mkMsg = (id: string, sessionId: string, text: string): ChatMessage => ({
  id, sessionId, role: "user", text, timestamp: 0,
});

test("appendMessage 持久化并可读回", async () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  await store.appendMessage("s1", mkMsg("m1", "s1", "你好"));
  const msgs = await store.loadMessages("s1");
  expect(msgs).toHaveLength(1);
  expect(msgs[0].text).toBe("你好");
  rmSync(dir, { recursive: true, force: true });
});

test("loadMessages 不存在返回空", async () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  expect(await store.loadMessages("nope")).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("appendAsk + resolveAsk", async () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  const ask: AskItem = {
    messageId: "a1", sessionId: "s1", from: "product", to: "dev",
    text: "问", startedAt: 0, resolved: false,
  };
  await store.appendAsk("s1", ask);
  let asks = await store.loadAsks("s1");
  expect(asks[0].resolved).toBe(false);
  await store.resolveAsk("s1", "a1");
  asks = await store.loadAsks("s1");
  expect(asks[0].resolved).toBe(true);
  expect(asks[0].resolvedAt).toBeDefined();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 实现 session-store.ts**

`packages/kernel/src/session-store.ts`:
```typescript
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
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/session-store.test.ts
# 期望: 3 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/session-store.ts packages/kernel/tests/session-store.test.ts
git commit -m "feat(kernel): SessionStore 读写 sessions/<id>.json（消息+委派事件）"
```

---
## Phase 2 — Kernel Pi 集成

