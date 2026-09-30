import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import { McpPage } from "../src/components/mcp/McpPage";
import { useMcpStore } from "../src/store/mcp";
import { useProjectsStore } from "../src/store/projects";

// 页面里唯一会发请求的是「保存配置」与「项目级开关真值回读」。
// mock 掉 api-client：既避免 happy-dom 对相对 URL 抛 NotSupportedError，
// 也能让「400 字段级错误绑到表单」与「开关真值回读端点」这两条链路被测到。
let postImpl: (path: string, body?: unknown) => Promise<unknown> = () =>
  Promise.resolve({ ok: true });
/** 记录 GET 路径：用于断言开关真值回读打的是哪个端点 */
const getCalls: string[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => {
      getCalls.push(path);
      return Promise.resolve(null);
    },
    post: (path: string, body?: unknown) => postImpl(path, body),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
}));

beforeEach(() => {
  postImpl = () => Promise.resolve({ ok: true });
  getCalls.length = 0;
  useMcpStore.setState({
    servers: [],
    stale: false,
    note: undefined,
    selectedProjectId: null,
    searchQuery: "",
    loading: false,
    projectScopeEnabled: null,
    serverStatuses: {},
    toolCounts: {},
    toolsCache: {},
    loadingTools: {},
    testingServers: {},
    errors: {},
    // 组件 mount 时 useEffect 会调用 load()，它内部会置 loading:true 并发请求。
    // 测试里不关心真实加载链路，stub 掉以避免 loading 阻塞渲染。
    load: () => {},
  });
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "测试项目", cwd: "/tmp/test", createdAt: 1 }],
    currentProjectId: "p1",
  } as any);
});

// beforeEach 把 mcp store 的 load action stub 成空函数，zustand store 是进程级单例，
// 不还原会泄漏给后面跑的测试文件（如 store-mcp.test.ts）——恢复初始 state（含原始 action）
afterEach(() => {
  useMcpStore.setState(useMcpStore.getInitialState(), true);
});

test("渲染标题和工具栏", () => {
  render(<McpPage />);
  expect(screen.getByText("🔌 MCP 连接器")).toBeTruthy();
  expect(screen.getByTestId("mcp-add-button")).toBeTruthy();
  expect(screen.getByTestId("mcp-scope-select")).toBeTruthy();
});

test("空列表显示空态", () => {
  render(<McpPage />);
  expect(screen.getByTestId("mcp-empty")).toBeTruthy();
});

test("点击 + 手动添加 展开表单", () => {
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-add-button"));
  expect(screen.getByTestId("mcp-form")).toBeTruthy();
});

test("搜索过滤列表", () => {
  useMcpStore.setState({
    servers: [
      { name: "chrome-devtools", command: "npx" },
      { name: "figma", url: "http://localhost:3845/mcp" },
    ],
  });
  render(<McpPage />);
  expect(screen.getByText(/chrome-devtools/)).toBeTruthy();
  expect(screen.getByText(/figma/)).toBeTruthy();

  const searchInput = screen.getByTestId("mcp-search");
  fireEvent.change(searchInput, { target: { value: "figma" } });
  expect(screen.queryByText(/chrome-devtools/)).toBeNull();
  expect(screen.getByText(/figma/)).toBeTruthy();
});

test("作用域切换", () => {
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-scope-select"));
  expect(screen.getByTestId("mcp-scope-option-global")).toBeTruthy();
  expect(screen.getByTestId("mcp-scope-option-project-p1")).toBeTruthy();
});

// ===== 编辑/新增表单应以模态弹窗形式打开 =====

test("点击 + 手动添加 在模态弹窗中打开空表单", () => {
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-add-button"));
  const modal = screen.getByTestId("mcp-form-modal");
  expect(within(modal).getByTestId("mcp-form")).toBeTruthy();
  expect((screen.getByTestId("mcp-form-name") as HTMLInputElement).value).toBe(
    "",
  );
  // 新 server 默认「直接可用」（规格 §4.2 产品决策）
  expect(
    (screen.getByTestId("mcp-form-exposure") as HTMLSelectElement).value,
  ).toBe("direct");
});

test("点击编辑在模态弹窗中打开表单并预填服务器配置", () => {
  useMcpStore.setState({
    servers: [{ name: "dbx", command: "dbx-mcp-server", args: ["serve"] }],
    serverStatuses: { dbx: "connected" },
  });
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-edit-dbx"));
  const modal = screen.getByTestId("mcp-form-modal");
  expect(within(modal).getByTestId("mcp-form")).toBeTruthy();
  expect((screen.getByTestId("mcp-form-name") as HTMLInputElement).value).toBe(
    "dbx",
  );
});

test("点击遮罩不关闭表单弹窗（防误触丢输入）", () => {
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-add-button"));
  expect(screen.getByTestId("mcp-form-modal")).toBeTruthy();
  fireEvent.click(screen.getByTestId("modal-overlay"));
  expect(screen.getByTestId("mcp-form")).toBeTruthy();
});

test("编辑/新增未打开时页面不渲染表单（不再是内联常驻）", () => {
  useMcpStore.setState({
    servers: [{ name: "dbx", command: "dbx-mcp-server" }],
  });
  render(<McpPage />);
  expect(screen.queryByTestId("mcp-form-modal")).toBeNull();
});

// ===== state 渲染（pi 原始串）=====

test("disabled 的 server 卡片显示「已停用」，不是错误样式", () => {
  useMcpStore.setState({
    servers: [{ name: "off-svr", command: "echo", state: "disabled" }],
  });
  render(<McpPage />);
  const badge = screen.getByTestId("mcp-state-off-svr");
  expect(badge.textContent).toContain("已停用");
  expect(badge.getAttribute("data-tone")).toBe("neutral");
});

test("needs-auth 的 server 提示需登录", () => {
  useMcpStore.setState({
    servers: [{ name: "auth-svr", url: "https://x/mcp", state: "needs-auth" }],
  });
  render(<McpPage />);
  expect(screen.getByTestId("mcp-state-auth-svr").textContent).toContain("需登录");
  expect(screen.getByTestId("mcp-needs-auth-auth-svr").textContent).toContain(
    "需要登录",
  );
});

test("pi 未报状态的 server 显示「状态未知」", () => {
  useMcpStore.setState({
    servers: [{ name: "unknown-svr", command: "echo" }],
  });
  render(<McpPage />);
  expect(screen.getByTestId("mcp-state-unknown-svr").textContent).toContain(
    "状态未知",
  );
});

// ===== stale / note =====

test("清单 stale 时显示「状态未知」横幅，且卡片不把旧状态当最新", () => {
  useMcpStore.setState({
    stale: true,
    servers: [{ name: "dbx", command: "echo", state: "connected" }],
  });
  render(<McpPage />);
  expect(screen.getByTestId("mcp-stale-banner").textContent).toContain(
    "状态未知",
  );
  expect(screen.getByTestId("mcp-state-dbx").textContent).toContain("状态未知");
});

test("项目未受信（pi 的 note）时提示配置未被加载", () => {
  useMcpStore.setState({
    note: "…/.pi/mcp.json is ignored because the project is not trusted.",
    servers: [{ name: "dbx", command: "echo" }],
  });
  render(<McpPage />);
  expect(screen.getByTestId("mcp-note-banner").textContent).toContain(
    ".pi/mcp.json",
  );
});

// ===== 项目级 MCP 作用域开关 =====

test("默认工作区（__system__）的项目级 MCP 开关置灰", () => {
  useProjectsStore.setState({
    projects: [
      { id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/workdir", createdAt: 0 },
      { id: "p1", name: "测试项目", cwd: "/tmp/test", createdAt: 1 },
    ],
    currentProjectId: SYSTEM_PROJECT_ID,
  } as any);
  useMcpStore.setState({ selectedProjectId: SYSTEM_PROJECT_ID });
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-scope-select"));
  const sw = screen.getByTestId("mcp-project-scope-switch") as HTMLButtonElement;
  expect(sw.disabled).toBe(true);
  expect(
    screen.getByTestId("mcp-project-scope-row").getAttribute("title"),
  ).toContain("默认工作区");
});

test("选中普通项目时项目级 MCP 开关可用，初值来自 trust.json 真值（已开）", () => {
  useMcpStore.setState({ selectedProjectId: "p1", projectScopeEnabled: true });
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-scope-select"));
  const sw = screen.getByTestId("mcp-project-scope-switch") as HTMLButtonElement;
  expect(sw.disabled).toBe(false);
  expect(sw.getAttribute("data-on")).toBe("true");
  expect(sw.getAttribute("data-unset")).toBe("false");
  expect(screen.queryByTestId("mcp-project-scope-unset")).toBeNull();
});

test("真值为未设置（null）时开关显示「未设置 / 跟随上层」，不谎报「已开」（缺口①回归）", () => {
  // pi 的 note（项目未受信）**不再**被当成开关初值：note 出现时 trust.json 里可能一条都没有
  useMcpStore.setState({
    selectedProjectId: "p1",
    projectScopeEnabled: null,
    note: "…/.pi/mcp.json is ignored because the project is not trusted.",
  });
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-scope-select"));
  const sw = screen.getByTestId("mcp-project-scope-switch") as HTMLButtonElement;
  expect(sw.getAttribute("data-on")).toBe("false");
  expect(sw.getAttribute("data-unset")).toBe("true");
  expect(
    screen.getByTestId("mcp-project-scope-unset").textContent,
  ).toContain("未设置");
});

test("真值为显式关闭（false）时是「关」而不是「未设置」", () => {
  useMcpStore.setState({ selectedProjectId: "p1", projectScopeEnabled: false });
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-scope-select"));
  const sw = screen.getByTestId("mcp-project-scope-switch") as HTMLButtonElement;
  expect(sw.getAttribute("data-on")).toBe("false");
  expect(sw.getAttribute("data-unset")).toBe("false");
  expect(screen.queryByTestId("mcp-project-scope-unset")).toBeNull();
});

test("选中具体项目时回读开关真值；全局 / 默认工作区不回读", async () => {
  useMcpStore.setState({ selectedProjectId: "p1" });
  render(<McpPage />);
  await waitFor(() =>
    expect(getCalls).toContain("/api/mcp/project-scope?projectId=p1"),
  );

  getCalls.length = 0;
  // 默认工作区没有项目级作用域（kernel 写侧 400），不回读
  await act(async () => {
    useMcpStore.setState({ selectedProjectId: SYSTEM_PROJECT_ID });
  });
  expect(getCalls).toEqual([]);
});

test("点击开关保存成功后就地更新真值（不再靠 note 推断）且 POST body 不变", async () => {
  const posts: unknown[] = [];
  postImpl = (path: string, body?: unknown) => {
    posts.push({ path, body });
    return Promise.resolve({ ok: true, enabled: true });
  };
  useMcpStore.setState({ selectedProjectId: "p1", projectScopeEnabled: false });
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-scope-select"));

  await act(async () => {
    fireEvent.click(screen.getByTestId("mcp-project-scope-switch"));
  });

  expect(posts).toEqual([
    {
      path: "/api/mcp/project-scope",
      body: { projectId: "p1", enabled: true },
    },
  ]);
  expect(useMcpStore.getState().projectScopeEnabled).toBe(true);
  expect(
    (screen.getByTestId("mcp-project-scope-switch") as HTMLButtonElement).getAttribute(
      "data-on",
    ),
  ).toBe("true");
});

test("选中全局作用域时不显示项目级 MCP 开关（它是项目维度的）", () => {
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-scope-select"));
  expect(screen.queryByTestId("mcp-project-scope-switch")).toBeNull();
});

// ===== 保存：400 字段级错误留在表单里 =====

test("保存被 400 拒绝时错误绑到字段且弹窗不关闭", async () => {
  postImpl = () =>
    Promise.reject(
      Object.assign(new Error("服务器名非法"), {
        errors: [{ field: "name", message: "只允许字母、数字、下划线与连字符" }],
      }),
    );
  useMcpStore.setState({
    servers: [{ name: "dbx", command: "dbx-mcp-server" }],
  });
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-edit-dbx"));
  fireEvent.click(screen.getByTestId("mcp-form-save"));
  expect(await screen.findByTestId("mcp-form-error-name")).toBeTruthy();
  expect(screen.getByTestId("mcp-form-modal")).toBeTruthy();
});

test("保存成功才关闭弹窗", async () => {
  useMcpStore.setState({
    servers: [{ name: "dbx", command: "dbx-mcp-server" }],
  });
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-edit-dbx"));
  // 保存是异步的（等 POST 回来才关闭）：用 act 把 pending 的 Promise 链一起刷完
  await act(async () => {
    fireEvent.click(screen.getByTestId("mcp-form-save"));
  });
  expect(screen.queryByTestId("mcp-form-modal")).toBeNull();
});
