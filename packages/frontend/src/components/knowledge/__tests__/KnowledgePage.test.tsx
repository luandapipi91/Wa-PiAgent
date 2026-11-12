// KnowledgePage 布局回归：「+ 新建知识库」与页面标题同一行；
// 卡片关联智能体行：mount 拉 /api/agents + /api/subagents 反查渲染，弹窗保存关闭后重拉刷新。
// 注：仓库无 vitest/jest-dom，沿用 bun:test + @testing-library/react 约定
// （断言 toBeTruthy 而非 toBeInTheDocument）。
// mock api-client：KnowledgePage mount 即拉清单（GET /api/knowledge）+ rerank 状态 + 智能体清单。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { KnowledgePage } from "../KnowledgePage";
import { useKnowledgeStore } from "../../../store/knowledge";
import type { KbInfo } from "@wa-pi/shared";

// 可变的智能体绑定数据（保存链路用例里 put 会就地修改，模拟 kernel 落盘后的重拉结果）
let agentsDb: any[] = [];
let subsDb: any[] = [];

const agent = (name: string, kbIds: string[]) => ({
  displayName: name,
  avatar: "",
  avatarColor: "",
  description: "",
  model: null,
  thinking: null,
  tools: [],
  skills: [],
  mcpServers: [],
  knowledgeBaseIds: kbIds,
  partners: [] as string[],
  systemPromptBody: "",
});
const sub = (name: string, kbIds: string[]) => ({
  name,
  displayName: name,
  description: "",
  emoji: "🤖",
  gradient: ["#111", "#222"],
  readOnly: false,
  systemPrompt: "",
  builtinToolNames: [],
  override: { type: name, model: null, thinking: null, knowledgeBaseIds: kbIds },
});

const kbReady: KbInfo = {
  id: "kb_1",
  name: "产品知识库",
  description: "",
  folderPath: "/docs",
  status: "ready",
  fileCount: 3,
  chunkCount: 10,
  failedCount: 0,
  autoWatch: true,
  lastIndexedAt: Date.now(),
};

mock.module("../../../api-client", () => ({
  api: {
    get: mock(async (path: string) => {
      if (path === "/api/knowledge") return { type: "knowledge:list", kbs: [kbReady] };
      if (path === "/api/knowledge/rerank")
        return { type: "knowledge:rerank", enabled: false, status: "idle", model: "" };
      if (path === "/api/agents") return { type: "agent:list", agents: agentsDb };
      if (path === "/api/subagents") return { type: "subagent:list", subagents: subsDb };
      return {};
    }),
    post: mock(async () => ({})),
    put: mock(async (path: string, body: any) => {
      // 命名智能体保存：就地改 agentsDb，模拟 kernel 落盘（重拉时生效）
      const m = path.match(/^\/api\/agents\/(.+)\/config$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        const target = agentsDb.find((a) => a.displayName === name);
        if (target) target.knowledgeBaseIds = body?.config?.knowledgeBaseIds ?? [];
      }
      return {};
    }),
    del: mock(async () => ({})),
  },
}));

// mount 时的清单拉取是异步 setState：flush 一次避免 act 警告
const flushLoad = () => act(async () => {});

beforeEach(() => {
  cleanup();
  agentsDb = [];
  subsDb = [];
  useKnowledgeStore.setState({
    kbs: [],
    loading: false,
    loaded: false,
    progress: {},
  });
});

test("「+ 新建知识库」在页面标题所在行内（同一标题栏），不单独占一行工具栏", async () => {
  render(<KnowledgePage />);
  const heading = screen.getByRole("heading", { name: /知识库/ });
  const button = screen.getByTestId("kb-add-button");
  // 同一行 = 同一父容器：旧实现按钮挂在标题栏下方的工具栏 div，标题栏容器不含它
  expect(heading.parentElement?.contains(button)).toBe(true);
  await flushLoad();
});

test("卡片显示已关联的智能体（命名 agent + 内置 subagent 反查），未关联的不出现", async () => {
  agentsDb = [agent("研发", ["kb_1"]), agent("产品", [])];
  subsDb = [sub("评审", ["kb_1"])];
  render(<KnowledgePage />);
  await flushLoad();
  const line = screen.getByTestId("kb-agents-line-kb_1");
  expect(line.textContent).toContain("研发、评审");
  expect(line.textContent).not.toContain("产品");
});

test("弹窗保存成功并关闭后，重新拉取绑定并刷新卡片上的智能体名单", async () => {
  agentsDb = [agent("研发", ["kb_1"]), agent("产品", [])];
  subsDb = [sub("评审", ["kb_1"])];
  render(<KnowledgePage />);
  await flushLoad();
  expect(screen.getByTestId("kb-agents-line-kb_1").textContent).not.toContain("产品");

  // 打开关联弹窗 → 勾「产品」→ 确认（写 PUT /api/agents/产品/config）
  fireEvent.click(screen.getByTestId("kb-agents-kb_1"));
  fireEvent.click(await screen.findByTestId("kb-agent-产品"));
  fireEvent.click(screen.getByTestId("kb-agents-confirm"));

  // 保存链是 act 外异步（put → onClose → 重拉绑定）：用 act + 短等待显式 flush。
  // 本环境（bun + happy-dom）waitFor 定时器不可靠，改用确定性等待
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  // 弹窗已关闭
  expect(screen.queryByTestId("kb-agents-modal")).toBeNull();
  // 重拉完成后，卡片名单包含新勾的「产品」（命名 agent 在前、内置在后）
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(screen.getByTestId("kb-agents-line-kb_1").textContent).toContain(
    "研发、产品、评审",
  );
});
