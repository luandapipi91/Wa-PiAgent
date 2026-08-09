import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { McpPage } from "../src/components/mcp/McpPage";
import { useMcpStore } from "../src/store/mcp";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => {
  useMcpStore.setState({
    servers: [],
    selectedProjectId: null,
    searchQuery: "",
    loading: false,
    serverStatuses: {},
    toolsCache: {},
    // 组件 mount 时 useEffect 会调用 load()，它内部会 set loading:true 并发送 WS。
    // mock WS 不响应 → loading 永远为 true → 列表一直显示"加载中..."。
    // 测试里我们不关心真实 WS 交互，stub 掉以避免 loading 阻塞渲染。
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
  expect((screen.getByTestId("mcp-form-name") as HTMLInputElement).value).toBe("");
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
  expect((screen.getByTestId("mcp-form-name") as HTMLInputElement).value).toBe("dbx");
});

test("点击遮罩关闭表单弹窗", () => {
  render(<McpPage />);
  fireEvent.click(screen.getByTestId("mcp-add-button"));
  expect(screen.getByTestId("mcp-form-modal")).toBeTruthy();
  fireEvent.click(screen.getByTestId("modal-overlay"));
  expect(screen.queryByTestId("mcp-form")).toBeNull();
});

test("编辑/新增未打开时页面不渲染表单（不再是内联常驻）", () => {
  useMcpStore.setState({
    servers: [{ name: "dbx", command: "dbx-mcp-server" }],
  });
  render(<McpPage />);
  expect(screen.queryByTestId("mcp-form-modal")).toBeNull();
});
