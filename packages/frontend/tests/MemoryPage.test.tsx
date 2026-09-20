import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryPage } from "../src/components/memory/MemoryPage";
import { useMemoryStore, dateFromToSinceMs, dateToToUntilMs } from "../src/store/memory";
import { useProjectsStore } from "../src/store/projects";
import type { MemoryEntry } from "@wa-pi/shared";

// 列表分页走服务端（GET /api/memories?limit=50&...）、检索走 /api/memories/search：
// mock api-client 的 GET 路由器 —— 分页路由按查询参数（scope/tab/kind）从内存数据集
// 过滤返回 memory:list:page 形状（counts 为徽标口径：scope+tab 全量，不随 kind/日期收窄，
// 与 kernel listPage 语义一致）；检索路由给出可配置响应；其余路由（config/instructions）返回 null。
const getMock = mock();
let searchResponse: unknown = { type: "memory:search", results: [], totalMatched: 0 };

const mkEntry = (
	id: string,
	scope: "global" | "project" = "global",
	text?: string,
	kind: MemoryEntry["kind"] = "knowledge",
): MemoryEntry => ({
	id,
	text: text ?? `记忆-${id}`,
	scope,
	kind,
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-01T00:00:00.000Z",
});

// 内存数据集（用例直接改写变量控制列表数据；beforeEach 重置为种子）
let savedEntries: MemoryEntry[] = [];
let archivedEntries: MemoryEntry[] = [];

const seedEntry = mkEntry(
	"5f1a2b3c-0000-4000-8000-000000000001",
	"global",
	"项目使用 pnpm",
);

// 组装 memory:list:page 响应：scope/tab 选数据源，kind 只收窄 entries 不收窄 counts（徽标口径）
const pageResponseFor = (url: string) => {
	const qs = new URLSearchParams(url.split("?")[1] ?? "");
	const scope = qs.get("scope");
	const kind = qs.get("kind");
	const source = qs.get("tab") === "archived" ? archivedEntries : savedEntries;
	const inScope = source.filter((e) => !scope || e.scope === scope);
	return {
		type: "memory:list:page",
		entries: inScope.filter((e) => !kind || e.kind === kind),
		hasMore: false,
		counts: {
			active: savedEntries.filter((e) => !scope || e.scope === scope).length,
			archived: archivedEntries.filter((e) => !scope || e.scope === scope).length,
		},
	};
};

mock.module("../src/api-client", () => ({
	api: {
		get: getMock,
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

const searchUrls = () =>
	getMock.mock.calls
		.map((c) => String(c[0]))
		.filter((u) => u.includes("/memories/search"));

const listUrls = () =>
	getMock.mock.calls
		.map((c) => String(c[0]))
		.filter((u) => u.startsWith("/api/memories?"));

// 本地时区今天（YYYY-MM-DD）：日期筛选用例断言 since/until 毫秒值用
const localToday = () => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const originalMemory = useMemoryStore.getState();
const originalProjects = useProjectsStore.getState();

beforeEach(() => {
	getMock.mockReset();
	savedEntries = [seedEntry];
	archivedEntries = [];
	searchResponse = { type: "memory:search", results: [], totalMatched: 0 };
	getMock.mockImplementation(async (url: string) => {
		if (url.includes("/memories/search")) return searchResponse;
		if (url.startsWith("/api/memories?")) return pageResponseFor(url);
		return null; // config / instructions 等其他路由
	});
  useProjectsStore.setState({
    currentProjectId: "p1",
    projects: [
      { id: "p1", name: "项目1", cwd: "/tmp/p1", createdAt: 0 },
      { id: "p2", name: "项目2", cwd: "/tmp/p2", createdAt: 0 },
    ],
  });
  useMemoryStore.setState({
		pageEntries: [],
		pageHasMore: false,
		pageCounts: { active: 1, archived: 0 },
		pageLoading: false,
		loadingMore: false,
		dateFrom: null,
		dateTo: null,
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
  // act 包裹：testing-library 的 cleanup 在用户 afterEach 之后执行，
  // 此时组件仍挂载，恢复 store 会触发订阅更新
  act(() => {
    useMemoryStore.setState(originalMemory);
    useProjectsStore.setState(originalProjects);
  });
});

test("渲染标题 + 内联开关 + 默认已保存 Tab（默认全局记忆）", async () => {
  render(<MemoryPage />);
  // 承接挂载期 loadPage/config 响应落地（避免 act 外更新告警）
  await act(async () => {});
  expect(screen.getByText("🧠 记忆")).toBeTruthy();
  expect(screen.getByTestId("tab-已保存")).toBeTruthy();
  // 列表数据经 loadPage 分页链路异步到达（mock 路由返回种子条目）
  await waitFor(() => {
    expect(screen.getByText("项目使用 pnpm")).toBeTruthy();
  });
  // 默认按钮文案为「全局记忆」
  expect(screen.getByTestId("memory-scope-select").textContent).toContain(
    "全局记忆",
  );
});

test("点击归档 Tab 切换到归档列表（服务端空页 → 空态）", async () => {
  render(<MemoryPage />);
  await act(async () => {}); // 承接挂载期响应
  fireEvent.click(screen.getByTestId("tab-归档"));
  // tab=archived 下推服务端，mock 归档数据集为空 → 空页 → 空态
  await act(async () => {}); // 承接切 tab 后的 loadPage 响应
  await waitFor(() => {
    expect(screen.getByTestId("memory-empty")).toBeTruthy();
  });
});

test("点击指令文件 Tab 展示指令列表", async () => {
  render(<MemoryPage />);
  await act(async () => {}); // 承接挂载期响应
  fireEvent.click(screen.getByTestId("tab-指令文件"));
  await act(async () => {}); // 承接 loadInstructions 响应
  expect(screen.getByTestId("instruction-item-project")).toBeTruthy();
});

test("搜索框触发服务端检索：渲染 snippet 与命中数，清空后回到完整列表", async () => {
  searchResponse = {
    type: "memory:search",
    results: [
      {
        id: "hit-1",
        title: "项目依赖",
        snippet: "项目使用 pnpm 作为包管理器",
        kind: "knowledge",
        scope: "global",
        updatedAt: "2026-08-01T00:00:00.000Z",
        score: 1.5,
        archived: false,
      },
    ],
    totalMatched: 1,
  };
  render(<MemoryPage />);
  const input = screen.getByTestId("memory-search") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "pnpm" } });

  await waitFor(() => {
    expect(searchUrls().length).toBeGreaterThan(0);
  });
  expect(searchUrls()[0]).toContain("q=pnpm");

  // 摘要（而非正文）来自服务端检索结果
  await waitFor(() => {
    expect(screen.getByText("项目使用 pnpm 作为包管理器")).toBeTruthy();
  });
  expect(screen.getByTestId("memory-search-total").textContent).toContain("1");

  // 清空输入 → 退出检索态，回到分页列表
  fireEvent.change(input, { target: { value: "" } });
  await waitFor(() => {
    expect(screen.queryByTestId("memory-search-total")).toBeNull();
  });
  await waitFor(() => {
    expect(screen.getByText("项目使用 pnpm")).toBeTruthy();
  });
});

test("层筛选下推服务端：检索态点「执行」后请求带 kind=execution", async () => {
  render(<MemoryPage />);
  const input = screen.getByTestId("memory-search") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "pnpm" } });
  await waitFor(() => expect(searchUrls().length).toBe(1));

  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  await waitFor(() => expect(searchUrls().length).toBe(2));
  expect(searchUrls()[1]).toContain("kind=execution");
});

test("检索在途显示「检索中」：不闪本地列表，也不显示上一轮结果", async () => {
  let resolveSearch: (v: unknown) => void = () => {};
  getMock.mockImplementation((url: string): Promise<unknown> =>
    url.includes("/memories/search")
      ? new Promise((res) => {
          resolveSearch = res;
        })
      : Promise.resolve(null),
  );
  render(<MemoryPage />);
  fireEvent.change(screen.getByTestId("memory-search"), {
    target: { value: "pnpm" },
  });

  // 防抖 + 请求在途：显示检索中，本地列表已让位（不再闪一下旧数据）
  await waitFor(() =>
    expect(screen.getByTestId("memory-search-status")).toBeTruthy(),
  );
  // 检索中三段式（同「没有匹配的记忆」空态规格）：🔍 + 「检索中：{词}」+ 提示语
  expect(screen.getByTestId("memory-empty-searching")).toBeTruthy();
  expect(screen.getByText("检索中：pnpm")).toBeTruthy();
  expect(screen.getByText("正在检索记忆，请等待……")).toBeTruthy();
  expect(screen.queryByText("项目使用 pnpm")).toBeNull();
  // 等请求真的发出（防抖结束），否则 resolve 句柄还是空函数
  await waitFor(() => expect(searchUrls().length).toBe(1));

  resolveSearch({
    type: "memory:search",
    results: [
      {
        id: "hit-1",
        title: "项目依赖",
        snippet: "第一轮命中",
        kind: "knowledge",
        scope: "global",
        updatedAt: "2026-08-01T00:00:00.000Z",
        score: 1,
        archived: false,
      },
    ],
    totalMatched: 1,
  });
  await waitFor(() => expect(screen.getByText("第一轮命中")).toBeTruthy());

  // 改词重检：在途阶段上一轮结果必须让位给「检索中」，不残留旧命中
  let resolveSecond: (v: unknown) => void = () => {};
  getMock.mockImplementation((url: string): Promise<unknown> =>
    url.includes("/memories/search")
      ? new Promise((res) => {
          resolveSecond = res;
        })
      : Promise.resolve(null),
  );
  fireEvent.change(screen.getByTestId("memory-search"), {
    target: { value: "pnpm 第二轮" },
  });
  await waitFor(() =>
    expect(screen.getByTestId("memory-search-status")).toBeTruthy(),
  );
  expect(screen.queryByText("第一轮命中")).toBeNull();
  await waitFor(() => expect(searchUrls().length).toBe(2));

  resolveSecond({
    type: "memory:search",
    results: [
      {
        id: "hit-2",
        title: "项目依赖",
        snippet: "第二轮命中",
        kind: "knowledge",
        scope: "global",
        updatedAt: "2026-08-02T00:00:00.000Z",
        score: 1,
        archived: false,
      },
    ],
    totalMatched: 1,
  });
  await waitFor(() => expect(screen.getByText("第二轮命中")).toBeTruthy());
});

test("检索无结果时显示专属空态", async () => {
  searchResponse = { type: "memory:search", results: [], totalMatched: 0 };
  render(<MemoryPage />);
  fireEvent.change(screen.getByTestId("memory-search"), {
    target: { value: "不存在的关键词" },
  });

  await waitFor(() => {
    expect(screen.getByTestId("memory-empty-search")).toBeTruthy();
  });
  expect(screen.getByText("没有匹配的记忆")).toBeTruthy();
});

test("归档 Tab 检索：请求带 archivedOnly=true，结果卡片带「已归档」徽标", async () => {
  searchResponse = {
    type: "memory:search",
    results: [
      {
        id: "hit-archived",
        title: "旧决策",
        snippet: "曾用 npm，后改 pnpm",
        kind: "knowledge",
        scope: "global",
        updatedAt: "2026-08-01T00:00:00.000Z",
        score: 0.9,
        archived: true,
      },
    ],
    totalMatched: 1,
  };
  render(<MemoryPage />);
  fireEvent.click(screen.getByTestId("tab-归档"));
  fireEvent.change(screen.getByTestId("memory-search"), {
    target: { value: "pnpm" },
  });

  await waitFor(() => expect(searchUrls().length).toBeGreaterThan(0));
  expect(searchUrls()[searchUrls().length - 1]).toContain("archivedOnly=true");
  await waitFor(() => {
    expect(screen.getByTestId("memory-card-archived-badge")).toBeTruthy();
  });
});

test("搜索结果卡片只读：不渲染「编辑」，保留「归档」", async () => {
  searchResponse = {
    type: "memory:search",
    results: [
      {
        id: "hit-2",
        title: "摘要",
        snippet: "这是一段检索摘要",
        kind: "knowledge",
        scope: "global",
        updatedAt: "2026-08-01T00:00:00.000Z",
        score: 1,
        archived: false,
      },
    ],
    totalMatched: 1,
  };
  render(<MemoryPage />);
  fireEvent.change(screen.getByTestId("memory-search"), {
    target: { value: "摘要" },
  });

  await waitFor(() => {
    expect(screen.getByText("这是一段检索摘要")).toBeTruthy();
  });
  expect(screen.queryByTestId("memory-edit")).toBeNull();
  expect(screen.getByTestId("memory-archive")).toBeTruthy();
  expect(screen.getByTestId("memory-card-snippet-hint")).toBeTruthy();
});

test("记忆卡片编辑 — 点击编辑展开文本框，保存后回调（带当前 projectId）", async () => {
  const editMock = mock();
  savedEntries = [
    mkEntry("33333333-3333-4333-8333-333333333333", "global", "原始内容"),
  ];
  useMemoryStore.setState({ update: editMock });

  render(<MemoryPage />);
  await waitFor(() => {
    expect(screen.getByTestId("memory-edit")).toBeTruthy();
  });
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

test("作用域下拉：展开后含「全局记忆」+ 每个项目", async () => {
  render(<MemoryPage />);
  await act(async () => {}); // 承接挂载期响应
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

test("选择某个项目 → 切到该项目记忆，按钮显示项目名", async () => {
  savedEntries = [
    mkEntry("44444444-4444-4444-8444-444444444444", "global", "全局A"),
    mkEntry("55555555-5555-4555-8555-555555555555", "project", "项目1专属"),
  ];
  render(<MemoryPage />);
  // 默认全局：scope=global 下推服务端 → 只见全局A
  await waitFor(() => {
    expect(screen.getByText("全局A")).toBeTruthy();
  });
  expect(screen.queryByText("项目1专属")).toBeNull();

  // 展开下拉，选择项目1
  fireEvent.click(screen.getByTestId("memory-scope-select"));
  fireEvent.click(screen.getByTestId("memory-scope-option-project-p1"));

  // 切到项目作用域：scope=project + projectId=p1 下推 → 只见项目记忆，按钮文案变为项目名
  await waitFor(() => {
    expect(screen.getByText("项目1专属")).toBeTruthy();
  });
  expect(screen.queryByText("全局A")).toBeNull();
  expect(screen.getByTestId("memory-scope-select").textContent).toContain(
    "项目1",
  );
});

test("选择「全局记忆」选项切回全局", async () => {
  savedEntries = [
    mkEntry("66666666-6666-4666-8666-666666666666", "global", "全局A"),
  ];
  useMemoryStore.setState({ memoryScope: "project" });
  render(<MemoryPage />);
  // 起始项目作用域：scope=project 过滤 → 空页，全局A 不可见
  await waitFor(() => {
    expect(screen.getByTestId("memory-empty")).toBeTruthy();
  });
  expect(screen.queryByText("全局A")).toBeNull();

  fireEvent.click(screen.getByTestId("memory-scope-select"));
  fireEvent.click(screen.getByTestId("memory-scope-option-global"));
  await waitFor(() => {
    expect(screen.getByText("全局A")).toBeTruthy();
  });
});

test("点击遮罩关闭下拉菜单", async () => {
  render(<MemoryPage />);
  await act(async () => {}); // 承接挂载期响应
  fireEvent.click(screen.getByTestId("memory-scope-select"));
  expect(screen.getByTestId("memory-scope-menu")).toBeTruthy();

  fireEvent.click(screen.getByTestId("memory-scope-backdrop"));
  expect(screen.queryByTestId("memory-scope-menu")).toBeNull();
});

test("项目作用域下添加记忆带 projectId", async () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock });
  render(<MemoryPage />);
  await act(async () => {}); // 承接挂载期响应

  // 先切到项目1
  fireEvent.click(screen.getByTestId("memory-scope-select"));
  fireEvent.click(screen.getByTestId("memory-scope-option-project-p1"));
  await act(async () => {}); // 承接切作用域触发的 loadPage 响应

  // 再添加
  fireEvent.click(screen.getByTestId("memory-add-button"));
  const textarea = screen.getByTestId(
    "memory-add-textarea",
  ) as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "新记忆" } });
  fireEvent.click(screen.getByTestId("memory-add-save"));

  expect(addMock).toHaveBeenCalledWith("project", "新记忆", "p1");
});

test("全局作用域下添加记忆不带 projectId", async () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock }); // 默认 global
  render(<MemoryPage />);
  await act(async () => {}); // 承接挂载期响应
  fireEvent.click(screen.getByTestId("memory-add-button"));
  const textarea = screen.getByTestId(
    "memory-add-textarea",
  ) as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "全局新记忆" } });
  fireEvent.click(screen.getByTestId("memory-add-save"));

  expect(addMock).toHaveBeenCalledWith("global", "全局新记忆", undefined);
});

test("添加空内容不会触发 memory:add", async () => {
  const addMock = mock();
  useMemoryStore.setState({ add: addMock });
  render(<MemoryPage />);
  await act(async () => {}); // 承接挂载期响应
  fireEvent.click(screen.getByTestId("memory-add-button"));
  fireEvent.click(screen.getByTestId("memory-add-save"));
  expect(addMock).not.toHaveBeenCalled();
});

// —— Bug 1 复现：关闭重开设置后，作用域选择器应保留上次选中的项目 ——
// 根因：selectedProjectId 原存在组件本地 state，弹窗卸载即丢失；
//       而 memoryScope 在持久 store 保留 → 两者错位，列表为空。
// 修复：selectedProjectId 提升到 store，关闭重开后仍保留。
test("Bug1: 关闭重开设置后，项目作用域仍显示上次选中的项目及其记忆", async () => {
  // 模拟「上次选了 aicpm 项目」的持久 store 状态（关闭弹窗后保留）
  useProjectsStore.setState({
    currentProjectId: null, // 无项目上下文打开设置
    projects: [{ id: "aicpm", name: "aicpm", cwd: "/tmp/aicpm", createdAt: 0 }],
  });
  savedEntries = [
    mkEntry("77777777-7777-4777-8777-777777777777", "global", "全局记忆"),
    mkEntry("88888888-8888-4888-8888-888888888888", "project", "aicpm 项目记忆"),
  ];
  useMemoryStore.setState({
    memoryScope: "project",
    selectedProjectId: "aicpm",
  });
  // 重新渲染（模拟关闭设置后重开 → MemoryPage 重新挂载，但 store 状态保留）
  render(<MemoryPage />);
  // 按钮应显示项目名「aicpm」，而非兜底的「项目记忆」
  expect(screen.getByTestId("memory-scope-select").textContent).toContain(
    "aicpm",
  );
  // scope=project + projectId=aicpm 下推服务端：项目记忆可见（非空）
  await waitFor(() => {
    expect(screen.getByText("aicpm 项目记忆")).toBeTruthy();
  });
  expect(screen.queryByText("全局记忆")).toBeNull();
});

// —— Bug 2 复现：指令文件 Tab 切到「项目」默认选第一个项目时应加载 ——
// 根因：<select> 首次渲染 DOM 默认选第一个 option，但不触发 React onChange，
//       selectedProjectId 仍为 null → 加载 effect 不执行。
// 修复：selectedProjectId 提升到 store 并用 activeProjectId 兜底；选择器始终显示。
test("Bug2: 指令文件 Tab 下项目选择器始终显示，且进入即加载当前项目指令", async () => {
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
  await act(async () => {}); // 承接挂载期响应
  // 切到指令文件 Tab
  fireEvent.click(screen.getByTestId("tab-指令文件"));
  // 选择器始终可见（不受 scopeFilter 影响）
  expect(screen.getByTestId("instruction-project-select")).toBeTruthy();
  // 进入 Tab 即应触发加载（用 activeProjectId = p1）
  expect(loadInstructionsMock).toHaveBeenCalledWith("p1");
});

// —— Bug 2 补充：无项目上下文时，指令文件 Tab 用 currentProjectId 兜底加载 ——
test("Bug2: selectedProjectId 为 null 时用 currentProjectId 兜底加载指令文件", async () => {
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
  await act(async () => {}); // 承接挂载期响应
  fireEvent.click(screen.getByTestId("tab-指令文件"));
  // activeProjectId = selectedProjectId ?? currentProjectId = "p2"
  expect(loadInstructionsMock).toHaveBeenCalledWith("p2");
});

// —— Bug 2 补充2：无任何项目上下文时，指令文件 Tab 仍触发加载（传空 projectId 走全局扫描） ——
test("Bug2: currentProjectId 和 selectedProjectId 均为 null 时，指令文件 Tab 仍加载全局指令", async () => {
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
  await act(async () => {}); // 承接挂载期响应
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

test("层筛选 — 点击「知识」只显示 knowledge 层，再点一次取消筛选", async () => {
  savedEntries = KIND_FIXTURE;
  render(<MemoryPage />);
  // 未筛选时四条都可见（scope=global 下推，kind 不筛），且卡片带层标签
  await waitFor(() => {
    expect(screen.getByText("画像条目")).toBeTruthy();
  });
  expect(screen.getByText("知识条目")).toBeTruthy();
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(
    document.querySelectorAll('[data-testid="memory-kind-badge"]').length,
  ).toBe(4);

  const knowledgeChip = screen.getByRole("button", { name: "知识" });
  fireEvent.click(knowledgeChip);
  // kind=knowledge 下推服务端：只留 knowledge 层
  await waitFor(() => {
    expect(screen.queryByText("画像条目")).toBeNull();
  });
  expect(screen.getByText("知识条目")).toBeTruthy();
  expect(screen.queryByText("执行失败条目")).toBeNull();
  expect(screen.getByText("知识失败条目")).toBeTruthy();
  expect(
    document.querySelectorAll('[data-testid^="memory-card-"]').length,
  ).toBe(2);

  // 再次点击同一层 → 取消筛选，三层恢复
  fireEvent.click(knowledgeChip);
  await waitFor(() => {
    expect(screen.getByText("画像条目")).toBeTruthy();
  });
  expect(screen.getByText("执行失败条目")).toBeTruthy();
});

test("层筛选 — 无命中时显示空态", async () => {
  savedEntries = [KIND_FIXTURE[1]]; // 只有 knowledge
  render(<MemoryPage />);
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  // kind=execution 下推 → 服务端空页 → 空态
  await waitFor(() => {
    expect(screen.getByTestId("memory-empty")).toBeTruthy();
  });
  expect(screen.queryByText("知识条目")).toBeNull();
});

test("层筛选：执行层只显示执行条目", async () => {
  savedEntries = [
    ...KIND_FIXTURE,
    {
      id: "aaaaaaaa-0000-4000-8000-000000000004",
      text: "执行成功条目",
      scope: "global",
      kind: "execution",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  render(<MemoryPage />);

  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  // 只剩 execution 层：两条执行条目
  await waitFor(() => {
    expect(screen.getByText("执行成功条目")).toBeTruthy();
  });
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(screen.queryByText("知识失败条目")).toBeNull();
  expect(screen.queryByText("知识条目")).toBeNull();
  expect(screen.queryByText("画像条目")).toBeNull();
});

// 工具栏布局（用户要求）：日期范围选择器放在搜索框之后、层级 tab 之前；
// 层级筛选移除「全部」chip——“全部”= 不筛选，仍可通过「再点一次已选中的层」取消回该状态，功能不减。
test("工具栏：日期范围选择器位于搜索框与层级筛选之间，且不再渲染「全部」层级 chip", async () => {
	savedEntries = KIND_FIXTURE;
	render(<MemoryPage />);
	await waitFor(() => {
		expect(screen.getByText("画像条目")).toBeTruthy();
	});

	// 反向断言：「全部」chip 已移除（层级筛选只剩画像/知识/执行）
	expect(screen.queryByRole("button", { name: "全部" })).toBeNull();

	// 位置：搜索框 → 日期选择器 → 层级筛选（DOM 顺序）
	const dateBtn = screen.getByTestId("memory-date-btn");
	const search = screen.getByTestId("memory-search");
	const kindFilter = screen.getByTestId("memory-kind-filter");
	expect(
		search.compareDocumentPosition(dateBtn) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		dateBtn.compareDocumentPosition(kindFilter) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});

test("层筛选：点「执行」只剩执行层，再点一次取消回全部层", async () => {
  savedEntries = KIND_FIXTURE;
  render(<MemoryPage />);

  // 未筛选：四条都可见
  await waitFor(() => {
    expect(screen.getByText("画像条目")).toBeTruthy();
  });
  expect(screen.getByText("知识条目")).toBeTruthy();
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(screen.getByText("知识失败条目")).toBeTruthy();

  // 点「执行」→ 只剩执行层
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  await waitFor(() => {
    expect(screen.queryByText("画像条目")).toBeNull();
  });
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(screen.queryByText("知识条目")).toBeNull();
  expect(screen.queryByText("知识失败条目")).toBeNull();

  // 再点「执行」（取消）→ 恢复全部层（「全部」chip 已移除，靠点击已选层取消）
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  await waitFor(() => {
    expect(screen.getByText("画像条目")).toBeTruthy();
  });
  expect(screen.getByText("知识条目")).toBeTruthy();
  expect(screen.getByText("执行失败条目")).toBeTruthy();
  expect(screen.getByText("知识失败条目")).toBeTruthy();
});

test("层筛选作用于当前作用域内的数据（项目作用域下按层筛选）", async () => {
  savedEntries = [
    mkEntry("bbbbbbbb-0000-4000-8000-000000000001", "global", "全局知识"),
    mkEntry("bbbbbbbb-0000-4000-8000-000000000002", "project", "项目知识"),
    mkEntry(
      "bbbbbbbb-0000-4000-8000-000000000003",
      "project",
      "项目执行",
      "execution",
    ),
  ];
  useMemoryStore.setState({ memoryScope: "project" });
  render(<MemoryPage />);
  await waitFor(() => {
    expect(screen.getByText("项目知识")).toBeTruthy();
  });
  expect(screen.getByText("项目执行")).toBeTruthy();
  expect(screen.queryByText("全局知识")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  // 作用域与层是两个正交维度：scope=project + kind=execution 一并下推服务端
  await waitFor(() => {
    expect(screen.queryByText("项目知识")).toBeNull();
  });
  expect(screen.getByText("项目执行")).toBeTruthy();
  expect(screen.queryByText("全局知识")).toBeNull();
});

// —— 任务 8 新增：日期范围筛选 / 滚动加载三态 / 服务端徽标计数 ——

test("日期范围变更触发 loadPage 且 URL 带 since/until", async () => {
  render(<MemoryPage />);
  // 打开日期弹层 → 快捷片「今天」→ 确定（不依赖 DayPicker 默认月 = 运行月份的当月依赖）
  fireEvent.click(screen.getByTestId("memory-date-btn"));
  fireEvent.click(screen.getByText("今天"));
  fireEvent.click(screen.getByTestId("memory-date-ok"));

  // setDateRange → listParams 变化 → loadPage 重新拉取，查询串带本地时区毫秒边界
  await waitFor(() => {
    expect(listUrls().some((u) => u.includes("since="))).toBe(true);
  });
  const today = localToday();
  const url = listUrls().find((u) => u.includes("since="))!;
  expect(url).toContain(`since=${dateFromToSinceMs(today)}`);
  expect(url).toContain(`until=${dateToToUntilMs(today)}`);
});

test("滚动哨兵出现且 hasMore 时渲染列表底部状态", async () => {
  // 列表请求挂起：不让 loadPage 响应覆盖预设的分页状态
  getMock.mockImplementation(() => new Promise(() => {}));
  useMemoryStore.setState({
    pageEntries: [seedEntry, mkEntry("e-2")],
    pageHasMore: true,
  });
  render(<MemoryPage />);
  // hasMore=true：哨兵常驻、无「已全部加载」、有「加载中」占位条件位
  expect(screen.getByTestId("memory-list-sentinel")).toBeTruthy();
  expect(screen.queryByTestId("memory-list-end")).toBeNull();

  // hasMore=false：显示「已全部加载 N 条」（外部 setState 触发订阅更新，包 act）
  act(() => {
    useMemoryStore.setState({ pageHasMore: false });
  });
  await waitFor(() => {
    expect(screen.getByTestId("memory-list-end")).toBeTruthy();
  });
  expect(screen.getByTestId("memory-list-end").textContent).toContain("2");
});

test("tab 徽标使用服务端 counts", () => {
  // 列表请求挂起：不让 loadPage 响应覆盖预设的 counts
  getMock.mockImplementation(() => new Promise(() => {}));
  useMemoryStore.setState({ pageCounts: { active: 49, archived: 6 } });
  render(<MemoryPage />);
  expect(screen.getByTestId("tab-已保存").textContent).toContain("49");
  expect(screen.getByTestId("tab-归档").textContent).toContain("6");
});
