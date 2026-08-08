import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentCreatePicker } from "./AgentCreatePicker";

const PRESETS = [
  { id: "engineering-code-reviewer", name: "代码审查员", description: "专业代码审查专家", emoji: "🔍", color: "#06B6D4", department: "工程部" },
  { id: "marketing-seo-specialist", name: "SEO专家", description: "搜索引擎优化", emoji: "📈", color: "#059669", department: "营销部" },
];

const getMock = mock(); const postMock = mock();
mock.module("../../api-client", () => ({ api: { get: getMock, post: postMock, put: mock(), del: mock() } }));

// agents store 需要 list 提供查重；直接设置 state
import { useAgentsStore } from "../../store/agents";

beforeEach(() => {
  getMock.mockReset(); postMock.mockReset();
  getMock.mockImplementation(async (path: string) =>
    path === "/api/agents/presets" ? { type: "agent:presets", presets: PRESETS } : {});
  useAgentsStore.setState({ list: [] } as any);
});

test("默认展示两个 Tab，预设 Tab 加载并分组展示", async () => {
  render(<AgentCreatePicker onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  expect(await screen.findByText("代码审查员")).toBeTruthy();
  expect(screen.getByText("工程部")).toBeTruthy();
  expect(screen.getByText("营销部")).toBeTruthy();
});

test("搜索按名字/描述过滤", async () => {
  render(<AgentCreatePicker onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  await screen.findByText("代码审查员");
  fireEvent.change(screen.getByTestId("preset-search-input"), { target: { value: "SEO" } });
  expect(screen.queryByText("代码审查员")).toBeNull();
  expect(screen.getByText("SEO专家")).toBeTruthy();
});

test("选中预设进入命名面板，随机名非空，可保存", async () => {
  const created: string[] = [];
  postMock.mockImplementation(async () => ({ type: "agent:created", agent: { displayName: "x" } }));
  render(<AgentCreatePicker onCreated={n => created.push(n)} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  fireEvent.click(await screen.findByTestId("preset-card-engineering-code-reviewer"));
  const input = (await screen.findByTestId("preset-name-input")) as HTMLInputElement;
  expect(input.value.length).toBeGreaterThanOrEqual(2);
  fireEvent.change(input, { target: { value: "林晓岚" } });
  fireEvent.click(screen.getByTestId("preset-save-btn"));
  await screen.findByTestId("agent-create-picker"); // 等待异步
  expect(postMock).toHaveBeenCalledWith("/api/agents/from-preset", {
    id: "engineering-code-reviewer", displayName: "林晓岚",
  });
  expect(created).toEqual(["林晓岚"]);
});

test("手改名字与现有智能体重名时保存置灰", async () => {
  useAgentsStore.setState({ list: [{ displayName: "林晓岚" }] } as any);
  render(<AgentCreatePicker onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  fireEvent.click(await screen.findByTestId("preset-card-engineering-code-reviewer"));
  fireEvent.change(await screen.findByTestId("preset-name-input"), { target: { value: "林晓岚" } });
  expect((screen.getByTestId("preset-save-btn") as HTMLButtonElement).disabled).toBe(true);
});

test("空白 Tab：随机名创建走 POST /api/agents", async () => {
  const created: string[] = [];
  postMock.mockImplementation(async () => ({ type: "agent:created", agent: {} }));
  render(<AgentCreatePicker onCreated={n => created.push(n)} />);
  const input = (await screen.findByTestId("blank-name-input")) as HTMLInputElement;
  expect(input.value.length).toBeGreaterThanOrEqual(2); // 已自动填随机名
  fireEvent.change(input, { target: { value: "苏念安" } });
  fireEvent.click(screen.getByTestId("blank-create-btn"));
  await new Promise(r => setTimeout(r, 0));
  expect(postMock).toHaveBeenCalledWith("/api/agents", { displayName: "苏念安" });
  expect(created).toEqual(["苏念安"]);
});

test("409 时 toast 提示且自动换名", async () => {
  const err = new Error("名称已被占用") as any; err.status = 409;
  postMock.mockImplementation(async () => { throw err; });
  render(<AgentCreatePicker onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("picker-tab-preset"));
  fireEvent.click(await screen.findByTestId("preset-card-engineering-code-reviewer"));
  const input = (await screen.findByTestId("preset-name-input")) as HTMLInputElement;
  const before = input.value;
  fireEvent.click(screen.getByTestId("preset-save-btn"));
  await new Promise(r => setTimeout(r, 0));
  expect(input.value).not.toBe(before); // 自动重随机
});
