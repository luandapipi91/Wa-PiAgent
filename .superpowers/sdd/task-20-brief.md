### Task 20: NewSessionPane 组件（新建会话面板）

**Files:**
- Create: `packages/frontend/src/components/NewSessionPane.tsx`
- Test: `packages/frontend/tests/NewSessionPane.test.tsx`

**Interfaces:**
- Consumes: `useProjectsStore`，`AGENT_DEFS`，`send`
- Produces: 输入框上方 `📁 项目目录 ▾` + `🤖 agent ▾` 下拉并排 + 输入框 + 发送

- [ ] **Step 1: 实现**

`packages/frontend/src/components/NewSessionPane.tsx`:
```typescript
import { useState } from "react";
import { AGENT_DEFS, randomSessionId } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";
import { useProjectsStore } from "../store/projects";
import { send } from "../ws-instance";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];

// 注：randomSessionId 加到 shared pure.ts（Step 2 补）
export function NewSessionPane() {
  const { projects, currentProjectId, addSession } = useProjectsStore();
  const [agentName, setAgentName] = useState<AgentName>("dev");
  const [text, setText] = useState("");
  const initialProject = currentProjectId ?? projects[0]?.id ?? null;
  const [projectId, setProjectId] = useState<string | null>(initialProject);

  const handleSend = () => {
    if (!projectId || !text.trim()) return;
    const sessionId = randomSessionId();
    send({ type: "agent:prompt", projectId, sessionId, agentName, text });
    setText("");
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6" data-testid="new-session-pane">
      <h2 className="text-2xl font-bold text-text mb-2">开始新会话</h2>
      <p className="text-subtext mb-6">选好项目目录和角色，直接打字发送</p>
      <div className="w-full max-w-2xl bg-surface rounded-lg overflow-hidden" style={{ background: "#313244" }}>
        <div className="flex gap-2 p-2 border-b border-surface2">
          <select
            value={projectId ?? ""}
            onChange={e => setProjectId(e.target.value || null)}
            className="flex-1 bg-mantle text-text rounded px-2 py-1 text-sm"
            data-testid="project-select"
          >
            {projects.length === 0 && <option value="">（无项目，请先新建）</option>}
            {projects.map(p => <option key={p.id} value={p.id}>📁 {p.name} {p.cwd}</option>)}
          </select>
          <select
            value={agentName}
            onChange={e => setAgentName(e.target.value as AgentName)}
            className="bg-mantle text-text rounded px-2 py-1 text-sm"
            data-testid="agent-select"
          >
            {NAMES.map(n => <option key={n} value={n}>{AGENT_DEFS[n].emoji} {AGENT_DEFS[n].label}</option>)}
          </select>
        </div>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="给研发发消息..."
          className="w-full bg-transparent text-text p-3 outline-none resize-none"
          rows={3}
          data-testid="new-session-input"
        />
        <div className="flex items-center justify-between p-2 border-t border-surface2">
          <span className="text-xs text-overlay">📎 附件 🎨 模型</span>
          <button
            onClick={handleSend}
            disabled={!projectId || !text.trim()}
            className="px-3 py-1 rounded text-sm"
            style={{ background: text.trim() && projectId ? "#89b4fa" : "#585b70", color: "#1e1e2e" }}
            data-testid="new-session-send"
          >发送 →</button>
        </div>
      </div>
      <p className="text-xs text-overlay mt-4">💡 项目目录可在此切换；agent 选谁谁是主理人</p>
    </div>
  );
}
```

- [ ] **Step 2: 测试**

`packages/frontend/tests/NewSessionPane.test.tsx`:
```typescript
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionPane } from "../src/components/NewSessionPane";
import { useProjectsStore } from "../src/store/projects";

// mock ws-instance.send
vi.mock("../src/ws-instance", () => ({
  send: vi.fn(),
  getWs: () => ({}),
  onMessage: () => () => {},
}));

beforeEach(() => useProjectsStore.setState({
  projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
  sessions: [], currentProjectId: "p1", currentSessionId: null,
}));

test("渲染项目+agent 下拉并排", () => {
  render(<NewSessionPane />);
  expect(screen.getByTestId("project-select")).toBeTruthy();
  expect(screen.getByTestId("agent-select")).toBeTruthy();
});

test("输入并发送调用 send", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  render(<NewSessionPane />);
  const input = screen.getByTestId("new-session-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "你好" } });
  fireEvent.click(screen.getByTestId("new-session-send"));
  expect(send).toHaveBeenCalled();
  const arg = (send as any).mock.calls[0][0];
  expect(arg.type).toBe("agent:prompt");
  expect(arg.projectId).toBe("p1");
  expect(arg.text).toBe("你好");
});
```

- [ ] **Step 4: 跑测试 + 提交**

```bash
bun run test
git add packages/frontend packages/shared/src/pure.ts
git commit -m "feat(frontend): NewSessionPane（新建会话面板，项目+agent 下拉并排）"
```

---

