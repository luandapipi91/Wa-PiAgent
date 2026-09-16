import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryPage } from "../src/components/memory/MemoryPage";
import { useMemoryStore } from "../src/store/memory";
import { useProjectsStore } from "../src/store/projects";
import type { MemoryEntry } from "@wa-pi/shared";

const originalMemory = useMemoryStore.getState();
const originalProjects = useProjectsStore.getState();

beforeEach(() => {
  useProjectsStore.setState({
    currentProjectId: "p1",
    projects: [
      { id: "p1", name: "项目1", cwd: "/tmp/p1", createdAt: 0 },
      { id: "p2", name: "项目2", cwd: "/tmp/p2", createdAt: 0 },
    ],
  });
  useMemoryStore.setState({
    memories: [
      {
        id: "5f1a2b3c-0000-4000-8000-000000000001",
        text: "项目使用 pnpm",
        scope: "global",
        kind: "knowledge",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    archived: [],
    instructions: [
      {
        path: "/fake/AGENTS.md",
        name: "AGENTS.md",
        scope: "project",
        content: "行为准则",
      },
    ],
    config: { reviewEnabled: true, memoryPolicyStyle: "full" },
    activeTab: "saved",
    scopeFilter: "all",
    memoryScope: "global",
    selectedProjectId: "p1",
    searchQuery: "",
  });
});

afterEach(() => {
  useMemoryStore.setState(originalMemory);
  useProjectsStore.setState(originalProjects);
});

test("渲染标题 + 内联开关 + 默认已保存 Tab（默认全局记忆）", () => {
  render(<MemoryPage />);
  expect(screen.getByText("🧠 记忆")).toBeTruthy();
  expect(screen.getByTestId("tab-已保存")).toBeTruthy();
  // 默认全局作用域 → 全局种子记忆可见
  expect(screen.getByText("项目使用 pnpm")).toBeTruthy();
  // 默认按钮文案为「全局记忆」
  expect(screen.getByTestId("memory-scope-select").textContent).toContain(
    "全局记忆",
  );
});

test("点击归档 Tab 切换到归档列表", () => {
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("tab-归档"));
  expect(screen.getByTestId("memory-empty")).toBeTruthy();
});

test("点击指令文件 Tab 展示指令列表", () => {
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("tab-指令文件"));
  expect(screen.getByTestId("instruction-item-project")).toBeTruthy();
});

test("搜索框过滤记忆", () => {
  render(<MemoryPage />);
  const input = screen.getByTestId("memory-search") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "pnpm" } });
  expect(screen.getByText("项目使用 pnpm")).toBeTruthy();

  fireEvent.change(input, { target: { value: "不存在的关键词" } });
  expect(screen.getByTestId("memory-empty")).toBeTruthy();
});

test("记忆卡片编辑 — 点击编辑展开文本框，保存后回调（带当前 projectId）", () => {
  const editMock = mock();
  useMemoryStore.setState({
    memories: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        text: "原始内容",
        scope: "global",
        kind: "knowledge",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  useMemoryStore.setState({ update: editMock });

  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("memory-edit"));
  const textarea = screen.getByTestId(
    "memory-edit-textarea",
  ) as HTMLTextAreaElement;
  expect(textarea.value).toBe("原始内容");

  fireEvent.change(textarea, { target: { value: "修改后内容" } });
  fireEvent.click(screen.getByTestId("memory-edit-save"));

  expect(editMock).toHaveBeenCalledWith(
    "p1",
    "33333333-3333-4333-8333-333333333333",
    "修改后内容",
  );
});

test("作用域下拉：展开后含「全局记忆」+ 每个项目", () => {
  render(<MemoryPage />);
  // 初始菜单未展开
  expect(screen.queryByTestId("memory-scope-menu")).toBeNull();

  fireEvent.click(screen.getByTestId("memory-scope-select"));
  expect(screen.getByTestId("memory-scope-option-global")).toBeTruthy();
  expect(screen.getByTestId("memory-scope-option-project-p1")).toBeTruthy();
  expect(screen.getByTestId("memory-scope-option-project-p2")).toBeTruthy();
  expect(
    screen.getByTestId("memory-scope-option-project-p1").textContent,
  ).toContain("项目1");
});

test("选择某个项目 → 切到该项目记忆，按钮显示项目名", () => {
  useMemoryStore.setState({
    memories: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        text: "全局A",
        scope: "global",
        kind: "knowledge",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        text: "项目1专属",
        scope: "project",
        kind: "knowledge",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  render(<MemoryPage />);
  // 默认全局：只看到全局A
  expect(screen.getByText("全局A")).toBeTruthy();
  expect(screen.queryByText("项目1专属")).toBeNull();

  // 展开下拉，选择项目1
  fireEvent.click(screen.getByTestId("memory-scope-select"));
  fireEvent.click(screen.getByTestId("memory-scope-option-project-p1"));

  // 切到项目作用域：只看到项目记忆，按钮文案变为项目名
  expect(screen.getByText("项目1专属")).toBeTruthy();
  expect(screen.queryByText("全局A")).toBeNull();
  expect(screen.getByTestId("memory-scope-select").textContent).toContain(
    "项目1",
  );
});

test("选择「全局记忆」选项切回全局", () => {
  useMemoryStore.setState({
    memories: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        text: "全局A",
        scope: "global",
        kind: "knowledge",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    memoryScope: "project",
  });
  render(<MemoryPage />);
  // 起始项目作用域：全局A 不可见
  expect(screen.queryByText("全局A")).toBeNull();

  fireEvent.click(screen.getByTestId("memory-scope-select"));
  fireEvent.click(screen.getByTestId("memory-scope-option-global"));
  expect(screen.getByText("全局A")).toBeTruthy();
});

test("点击遮罩关闭下拉菜单", () => {
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("memory-scope-select"));
  expect(screen.getByTestId("memory-scope-menu")).toBeTruthy();

  fireEvent.click(screen.getByTestId("memory-scope-backdrop"));
  expect(screen.queryByTestId("memory-scope-menu")).toBeNull();
});

test("项目作用域下添加记忆带 projectId", () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock });
  render(<MemoryPage />);

  // 先切到项目1
  fireEvent.click(screen.getByTestId("memory-scope-select"));
  fireEvent.click(screen.getByTestId("memory-scope-option-project-p1"));

  // 再添加
  fireEvent.click(screen.getByTestId("memory-add-button"));
  const textarea = screen.getByTestId(
    "memory-add-textarea",
  ) as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "新记忆" } });
  fireEvent.click(screen.getByTestId("memory-add-save"));

  expect(addMock).toHaveBeenCalledWith("project", "新记忆", "p1");
});

test("全局作用域下添加记忆不带 projectId", () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock }); // 默认 global
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("memory-add-button"));
  const textarea = screen.getByTestId(
    "memory-add-textarea",
  ) as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "全局新记忆" } });
  fireEvent.click(screen.getByTestId("memory-add-save"));

  expect(addMock).toHaveBeenCalledWith("global", "全局新记忆", undefined);
});

test("添加空内容不会触发 memory:add", () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock });
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("memory-add-button"));
  fireEvent.click(screen.getByTestId("memory-add-save"));
  expect(addMock).not.toHaveBeenCalled();
});

// —— Bug 1 复现：关闭重开设置后，作用域选择器应保留上次选中的项目 ——
// 根因：selectedProjectId 原存在组件本地 state，弹窗卸载即丢失；
//       而 memoryScope 在持久 store 保留 → 两者错位，列表为空。
// 修复：selectedProjectId 提升到 store，关闭重开后仍保留。
test("Bug1: 关闭重开设置后，项目作用域仍显示上次选中的项目及其记忆", () => {
  // 模拟「上次选了 aicpm 项目」的持久 store 状态（关闭弹窗后保留）
  useProjectsStore.setState({
    currentProjectId: null, // 无项目上下文打开设置
    projects: [{ id: "aicpm", name: "aicpm", cwd: "/tmp/aicpm", createdAt: 0 }],
  });
  useMemoryStore.setState({
    memoryScope: "project",
    selectedProjectId: "aicpm",
    memories: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        text: "全局记忆",
        scope: "global",
        kind: "knowledge",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "88888888-8888-4888-8888-888888888888",
        text: "aicpm 项目记忆",
        scope: "project",
        kind: "knowledge",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  // 重新渲染（模拟关闭设置后重开 → MemoryPage 重新挂载，但 store 状态保留）
  render(<MemoryPage />);
  // 按钮应显示项目名「aicpm」，而非兜底的「项目记忆」
  expect(screen.getByTestId("memory-scope-select").textContent).toContain(
    "aicpm",
  );
  // 项目记忆应可见（非空）
  expect(screen.getByText("aicpm 项目记忆")).toBeTruthy();
  expect(screen.queryByText("全局记忆")).toBeNull();
});

// —— Bug 2 复现：指令文件 Tab 切到「项目」默认选第一个项目时应加载 ——
// 根因：<select> 首次渲染 DOM 默认选第一个 option，但不触发 React onChange，
//       selectedProjectId 仍为 null → 加载 effect 不执行。
// 修复：selectedProjectId 提升到 store 并用 activeProjectId 兜底；选择器始终显示。
test("Bug2: 指令文件 Tab 下项目选择器始终显示，且进入即加载当前项目指令", () => {
  const loadInstructionsMock = mock();
  useProjectsStore.setState({
    currentProjectId: "p1",
    projects: [{ id: "p1", name: "项目1", cwd: "/tmp/p1", createdAt: 0 }],
  });
  useMemoryStore.setState({
    selectedProjectId: "p1",
    scopeFilter: "global", // 即使在「全局」作用域下，选择器也应可见
    loadInstructions: loadInstructionsMock,
  });
  render(<MemoryPage />);
  // 切到指令文件 Tab
  fireEvent.click(screen.getByTestId("tab-指令文件"));
  // 选择器始终可见（不受 scopeFilter 影响）
  expect(screen.getByTestId("instruction-project-select")).toBeTruthy();
  // 进入 Tab 即应触发加载（用 activeProjectId = p1）
  expect(loadInstructionsMock).toHaveBeenCalledWith("p1");
});

// —— Bug 2 补充：无项目上下文时，指令文件 Tab 用 currentProjectId 兜底加载 ——
test("Bug2: selectedProjectId 为 null 时用 currentProjectId 兜底加载指令文件", () => {
  const loadInstructionsMock = mock();
  useProjectsStore.setState({
    currentProjectId: "p2",
    projects: [{ id: "p2", name: "项目2", cwd: "/tmp/p2", createdAt: 0 }],
  });
  useMemoryStore.setState({
    selectedProjectId: null, // store 里尚未选过
    loadInstructions: loadInstructionsMock,
  });
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("tab-指令文件"));
  // activeProjectId = selectedProjectId ?? currentProjectId = "p2"
  expect(loadInstructionsMock).toHaveBeenCalledWith("p2");
});

// —— Bug 2 补充2：无任何项目上下文时，指令文件 Tab 仍触发加载（传空 projectId 走全局扫描） ——
test("Bug2: currentProjectId 和 selectedProjectId 均为 null 时，指令文件 Tab 仍加载全局指令", () => {
  const loadInstructionsMock = mock();
  useProjectsStore.setState({
    currentProjectId: null,
    projects: [],
  });
  useMemoryStore.setState({
    selectedProjectId: null,
    loadInstructions: loadInstructionsMock,
    activeTab: "saved",
  });
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("tab-指令文件"));
  // 即使 activeProjectId 为 null，也应触发 loadInstructions("") 扫描全局指令文件
  expect(loadInstructionsMock).toHaveBeenCalledWith("");
});

// —— 层标签 / 层筛选（任务 14：SQLite 三层记忆的前端适配） ——
// 新数据模型下条目自带 kind（profile 画像 / knowledge 知识 / execution 执行），
// 面板需能按层筛选；fixture 用 uuid 形式 id，与 DB 一致。
const KIND_FIXTURE: MemoryEntry[] = [
  {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    text: "画像条目",
    scope: "global",
    kind: "profile",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    text: "知识条目",
    scope: "global",
    kind: "knowledge",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000003",
    text: "执行失败条目",
    scope: "global",
    kind: "execution",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "aaaaaaaa-0000-4000-8000-000000000005",
    text: "知识失败条目",
    scope: "global",
    kind: "knowledge",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

test("层筛选 — 点击「知识」只显示 knowledge 层，再点一次取消筛选", () => {
  useMemoryStore.setState({ memories: KIND_FIXTURE });
  render(<MemoryPage />);
  // 未筛选时三层都可见，且卡片带层标签
  expect(screen.getByText("画像条目")).toBeTruthy();
  expect(screen.getByText("知识条目")).toBeTruthy();
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(
    document.querySelectorAll('[data-testid="memory-kind-badge"]').length,
  ).toBe(4);

  const knowledgeChip = screen.getByRole("button", { name: "知识" });
  fireEvent.click(knowledgeChip);
  // 只留 knowledge 层
  expect(screen.getByText("知识条目")).toBeTruthy();
  expect(screen.queryByText("画像条目")).toBeNull();
  expect(screen.queryByText("执行失败条目")).toBeNull();
  expect(screen.queryByText("知识失败条目")).toBeTruthy();
  expect(
    document.querySelectorAll('[data-testid^="memory-card-"]').length,
  ).toBe(2);

  // 再次点击同一层 → 取消筛选，三层恢复
  fireEvent.click(knowledgeChip);
  expect(screen.getByText("画像条目")).toBeTruthy();
  expect(screen.getByText("执行失败条目")).toBeTruthy();
});

test("层筛选 — 无命中时显示空态", () => {
  useMemoryStore.setState({
    memories: [KIND_FIXTURE[1]], // 只有 knowledge
  });
  render(<MemoryPage />);
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  expect(screen.getByTestId("memory-empty")).toBeTruthy();
  expect(screen.queryByText("知识条目")).toBeNull();
});

test("层筛选：执行层只显示执行条目", () => {
  useMemoryStore.setState({
    memories: [
      ...KIND_FIXTURE,
      {
        id: "aaaaaaaa-0000-4000-8000-000000000004",
        text: "执行成功条目",
        scope: "global",
        kind: "execution",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  render(<MemoryPage />);

  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  // 只剩 execution 层：两条执行条目
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(screen.getByText("执行成功条目")).toBeTruthy();
  expect(screen.queryByText("知识失败条目")).toBeNull();
  expect(screen.queryByText("知识条目")).toBeNull();
  expect(screen.queryByText("画像条目")).toBeNull();
});

test("层筛选：点「执行」只剩执行层，再点「全部」恢复全部层", () => {
  useMemoryStore.setState({ memories: KIND_FIXTURE });
  render(<MemoryPage />);

  // 未筛选：四层条目都可见
  expect(screen.getByText("画像条目")).toBeTruthy();
  expect(screen.getByText("知识条目")).toBeTruthy();
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(screen.getByText("知识失败条目")).toBeTruthy();

  // 点「执行」→ 只剩执行层
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(screen.queryByText("画像条目")).toBeNull();
  expect(screen.queryByText("知识条目")).toBeNull();
  expect(screen.queryByText("知识失败条目")).toBeNull();

  // 点「全部」→ 恢复全部层
  fireEvent.click(screen.getByRole("button", { name: "全部" }));
  expect(screen.getByText("画像条目")).toBeTruthy();
  expect(screen.getByText("知识条目")).toBeTruthy();
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(screen.getByText("知识失败条目")).toBeTruthy();
});

test("层筛选作用于当前作用域内的数据（项目作用域下按层筛选）", () => {
  useMemoryStore.setState({
    memories: [
      {
        id: "bbbbbbbb-0000-4000-8000-000000000001",
        text: "全局知识",
        scope: "global",
        kind: "knowledge",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "bbbbbbbb-0000-4000-8000-000000000002",
        text: "项目知识",
        scope: "project",
        kind: "knowledge",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "bbbbbbbb-0000-4000-8000-000000000003",
        text: "项目执行",
        scope: "project",
        kind: "execution",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    memoryScope: "project",
  });
  render(<MemoryPage />);
  expect(screen.getByText("项目知识")).toBeTruthy();
  expect(screen.getByText("项目执行")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  // 作用域与层是两个正交维度：先限项目，再限执行层
  expect(screen.getByText("项目执行")).toBeTruthy();
  expect(screen.queryByText("项目知识")).toBeNull();
  expect(screen.queryByText("全局知识")).toBeNull();
});
