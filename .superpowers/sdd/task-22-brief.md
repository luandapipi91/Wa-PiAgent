### Task 22: MessageList 组件

**Files:**
- Create: `packages/frontend/src/components/MessageList.tsx`
- Test: `packages/frontend/tests/MessageList.test.tsx`

**Interfaces:**
- Consumes: `useSessionStore`
- Produces: 按 sessionId 渲染消息流

- [ ] **Step 1: 实现**

`packages/frontend/src/components/MessageList.tsx`:
```typescript
import type { ChatMessage } from "@hiagent/shared";
import { useSessionStore } from "../store/session";

interface Props { sessionId: string; }

export function MessageList({ sessionId }: Props) {
  const messages = useSessionStore(s => s.messagesBySession[sessionId] ?? []);
  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-3.5" data-testid="message-list">
      {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className="flex gap-2" data-testid={`msg-${msg.id}`}>
      <div
        className="max-w-[70%] px-3 py-2"
        style={{
          background: isUser ? "#313244" : "#181825",
          borderRadius: isUser ? "4px 12px 12px 12px" : "12px 4px 12px 12px",
          color: "#cdd6f4",
        }}
      >
        <div className="text-xs text-overlay mb-0.5">{isUser ? "你" : "agent"}</div>
        <div className="text-sm whitespace-pre-wrap">{msg.text}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/MessageList.test.tsx`:
```typescript
import { test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../store/session";

beforeEach(() => useSessionStore.setState({ messagesBySession: {} }));

test("渲染指定 session 的消息", () => {
  useSessionStore.setState({
    messagesBySession: {
      s1: [
        { id: "m1", sessionId: "s1", role: "user", text: "你好", timestamp: 0 },
        { id: "m2", sessionId: "s1", role: "assistant", text: "收到", timestamp: 0 },
      ],
    },
  });
  render(<MessageList sessionId="s1" />);
  expect(screen.getByText("你好")).toBeTruthy();
  expect(screen.getByText("收到")).toBeTruthy();
});

test("空 session 无消息", () => {
  render(<MessageList sessionId="empty" />);
  expect(screen.getByTestId("message-list").children).toHaveLength(0);
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/MessageList.tsx packages/frontend/tests/MessageList.test.tsx
git commit -m "feat(frontend): MessageList（按 sessionId 取消息流）"
```

---

