### Task 24: AskCard 组件（委派内联卡片 + 干预）

**Files:**
- Create: `packages/frontend/src/components/AskCard.tsx`
- Test: `packages/frontend/tests/AskCard.test.tsx`

**Interfaces:**
- Consumes: `useAgentsStore`（agentEmoji），`send`（inject-reply）
- Produces: 渲染橙色委派卡片 + "🙋 我来回答"按钮，点击展开输入框提交

- [ ] **Step 1: 实现**

`packages/frontend/src/components/AskCard.tsx`:
```typescript
import { useState } from "react";
import type { AskItem } from "@hiagent/shared";
import { send } from "../ws-instance";
import { agentEmoji } from "../theme/agents";

interface Props { ask: AskItem; }

export function AskCard({ ask }: Props) {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState("");
  const elapsed = Math.floor((Date.now() - ask.startedAt) / 1000);

  const submit = () => {
    if (!text.trim()) return;
    send({ type: "intercom:inject-reply", sessionId: ask.sessionId, askMessageId: ask.messageId, text });
    setText("");
    setAnswering(false);
  };

  const borderColor = ask.resolved ? "#a6e3a1" : "rgba(250,179,135,0.3)";
  const bgColor = ask.resolved ? "rgba(166,227,161,0.1)" : "rgba(250,179,135,0.1)";

  return (
    <div
      className="rounded-lg p-3 my-2"
      style={{ background: bgColor, border: `1px solid ${borderColor}` }}
      data-testid={`ask-${ask.messageId}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm" style={{ color: ask.resolved ? "#a6e3a1" : "#fab387" }}>
          {ask.resolved ? "✓ 已回复" : `↗ 委派给 ${agentEmoji(ask.to)}`}
        </span>
        {!ask.resolved && (
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(250,179,135,0.2)", color: "#fab387" }}>
            ask · 阻塞中 {elapsed}s
          </span>
        )}
      </div>
      <p className="text-sm text-text italic mb-2">"{ask.text}"</p>
      {ask.resolved ? null : answering ? (
        <div className="flex gap-2">
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="替被问 agent 输入回复..."
            className="flex-1 bg-mantle text-text rounded px-2 py-1 text-sm outline-none"
            data-testid="ask-input"
          />
          <button onClick={submit} className="px-3 py-1 rounded text-sm" style={{ background: "#a6e3a1", color: "#1e1e2e" }}>提交</button>
        </div>
      ) : (
        <button
          onClick={() => setAnswering(true)}
          className="px-3 py-1 rounded text-sm"
          style={{ background: "#313244", color: "#a6e3a1" }}
          data-testid="ask-answer-btn"
        >🙋 我来回答</button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/AskCard.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskCard } from "../src/components/AskCard";
import type { AskItem } from "@hiagent/shared";

vi.mock("../src/ws-instance", () => ({ send: vi.fn() }));

const ask: AskItem = {
  messageId: "a1", sessionId: "s1", from: "product", to: "dev",
  text: "WebSocket 怎么选", startedAt: Date.now() - 23000, resolved: false,
};

test("未解决显示阻塞计时", () => {
  render(<AskCard ask={ask} />);
  expect(screen.getByText(/阻塞中/)).toBeTruthy();
});

test("点击我来回答展开输入", () => {
  render(<AskCard ask={ask} />);
  fireEvent.click(screen.getByTestId("ask-answer-btn"));
  expect(screen.getByTestId("ask-input")).toBeTruthy();
});

test("提交调 inject-reply", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  render(<AskCard ask={ask} />);
  fireEvent.click(screen.getByTestId("ask-answer-btn"));
  fireEvent.change(screen.getByTestId("ask-input"), { target: { value: "用 SSE" } });
  fireEvent.click(screen.getByText("提交"));
  expect(send).toHaveBeenCalledWith({
    type: "intercom:inject-reply", sessionId: "s1", askMessageId: "a1", text: "用 SSE",
  });
});
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend/src/components/AskCard.tsx packages/frontend/tests/AskCard.test.tsx
git commit -m "feat(frontend): AskCard（委派内联卡片 + 🙋 我来回答 干预）"
```

---

